import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const codexVersion = '0.160.1';
const folder = path.dirname(fileURLToPath(import.meta.url));

export function findStation(profile, exists = fs.existsSync) {
  const candidates = [
    path.join(profile, 'Documents', 'GitHub', 'starnet'),
    path.join(profile, 'Documents', 'GitHub', 'starnet-council'),
    'C:\\NexusAI\\Council-Restore-20260928',
  ];
  return candidates.find(p => exists(path.join(p, 'sidecar', 'index.js'))) || null;
}

export function agentArgs(station, state, packageFolder, exists = fs.existsSync) {
  const roots = [state, packageFolder, 'C:\\NexusAI\\Recovery', 'C:\\NexusAI\\.ef-nexus-workspaces'];
  const args = ['--cd', station, '--sandbox', 'workspace-write', '--ask-for-approval', 'on-request'];
  for (const root of roots) if (exists(root)) args.push('--add-dir', root);
  args.push(`Continue the authorized EF Agent Council repair on this Windows PC. Read ${path.join(packageFolder, 'REPAIR-BRIEF.md')} and ${path.join(packageFolder, 'LOCAL-MISSION.md')} first. Read existing ${path.join(state, 'PROGRESS.md')} before doing any work. Work directly, repair and verify, and preserve rollback. Save progress there after each meaningful change. Do not ask the user to copy diagnostic commands. Do not report fixed until the live acceptance gates pass. Candidate fixes and tests are in ${path.join(packageFolder, 'candidate')}.`);
  return args;
}

function run(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { stdio: 'inherit', shell: false, ...options });
    child.once('error', reject);
    child.once('exit', code => resolve(code ?? 1));
  });
}

function npmCli() {
  // Run npm's JS entry directly. Avoid PowerShell execution-policy changes and
  // avoid shell interpolation of paths or downloaded content.
  const roots = [path.dirname(process.execPath), process.env.APPDATA && path.join(process.env.APPDATA, 'npm')].filter(Boolean);
  return roots.map(p => path.join(p, 'node_modules', 'npm', 'bin', 'npm-cli.js')).find(p => fs.existsSync(p));
}

export async function main() {
  if (process.platform !== 'win32') throw Error('This launcher is for the Windows PC that runs Council.');
  const station = findStation(process.env.USERPROFILE || os.homedir());
  if (!station) throw Error('The known Council checkout is not present. Open its actual folder in the Windows desktop app and attach REPAIR-BRIEF.md.');
  if (!process.env.LOCALAPPDATA) throw Error('LOCALAPPDATA is unavailable. Start as your normal Windows account.');
  const state = path.join(process.env.LOCALAPPDATA, 'EFVentures', 'CouncilRepairAgent');
  const install = path.join(state, 'codex-' + codexVersion);
  const manifest = path.join(install, 'node_modules', '@openai', 'codex', 'package.json');
  const cli = path.join(install, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  fs.mkdirSync(state, { recursive: true });
  let installed = false;
  try { installed = JSON.parse(fs.readFileSync(manifest, 'utf8')).version === codexVersion && fs.existsSync(cli); } catch {}
  if (!installed) {
    const npm = npmCli();
    if (!npm) throw Error('The npm entry bundled with Node.js is unavailable. No system configuration was changed.');
    console.log('Installing the official OpenAI Codex CLI ' + codexVersion + ' in your user profile.');
    const code = await run(process.execPath, [npm, 'install', '--prefix', install, '--no-audit', '--no-fund', '@openai/codex@' + codexVersion]);
    if (code !== 0) throw Error('Official Codex installation did not finish. Check the error above; do not disable Bitdefender.');
    if (JSON.parse(fs.readFileSync(manifest, 'utf8')).version !== codexVersion || !fs.existsSync(cli)) throw Error('Codex installation verification failed.');
  }
  console.log('Council repair will run in: ' + station);
  console.log('This starts the local coding agent. It does not claim Council is already repaired.');
  console.log('Sign in with your ChatGPT account if requested. Keep this window open.');
  const login = await run(process.execPath, [cli, 'login', 'status']);
  if (login !== 0 && await run(process.execPath, [cli, 'login']) !== 0) throw Error('ChatGPT sign-in was not completed.');
  return run(process.execPath, [cli, ...agentArgs(station, state, folder)], { cwd: station });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(code => { process.exitCode = code; }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
