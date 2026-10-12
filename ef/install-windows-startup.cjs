'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { launch } = require('./start-background.cjs');

const marker = 'EF Agent Studio local runtime startup (managed)';
const psQuote = value => "'" + String(value).replace(/'/g, "''") + "'";
function installationScript({ directory = __dirname, node = process.execPath, remove = false } = {}) {
  const root = path.dirname(directory);
  const runner = path.join(directory, 'start-background.cjs');
  // EncodedCommand avoids nested Windows command-line quoting and needs no policy changes.
  const command = '& ' + psQuote(node) + ' ' + psQuote(runner);
  const encoded = Buffer.from(command, 'utf16le').toString('base64');
  const args = '-NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand ' + encoded;
  return `
$ErrorActionPreference = 'Stop'
$startup = [Environment]::GetFolderPath('Startup')
if (-not $startup) { throw 'Windows did not return a user Startup folder.' }
$shortcutPath = Join-Path $startup 'EF Agent Studio.lnk'
$shell = New-Object -ComObject WScript.Shell
if (Test-Path -LiteralPath $shortcutPath) {
  $existing = $shell.CreateShortcut($shortcutPath)
  if ($existing.Description -ne ${psQuote(marker)}) {
    throw 'An unrelated EF Agent Studio shortcut already exists. It was left unchanged.'
  }
}
${remove ? `
if (Test-Path -LiteralPath $shortcutPath) { Remove-Item -LiteralPath $shortcutPath }
Write-Output 'EF Agent Studio automatic startup removed. Running processes were left alone.'
` : `
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = Join-Path $PSHOME 'powershell.exe'
$shortcut.Arguments = ${psQuote(args)}
$shortcut.WorkingDirectory = ${psQuote(root)}
$shortcut.WindowStyle = 7
$shortcut.Description = ${psQuote(marker)}
$shortcut.Save()
$verify = $shell.CreateShortcut($shortcutPath)
if ($verify.Arguments -ne ${psQuote(args)} -or $verify.WorkingDirectory -ne ${psQuote(root)} -or $verify.Description -ne ${psQuote(marker)}) {
  throw 'Startup shortcut verification failed.'
}
Write-Output ('Installed and verified: ' + $shortcutPath)
`}
`;
}
async function install() {
  if (process.platform !== 'win32') throw new Error('Run this installer on your Windows computer.');
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Node.js 22 or newer is required.');
  const remove = process.argv.includes('--remove');
  if (!remove && !fs.existsSync(path.join(__dirname, 'node_modules', 'ajv', 'package.json'))) {
    throw new Error('Install the EF dependencies first: npm ci --prefix ef');
  }
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = installationScript({ remove });
  const output = execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(script, 'utf16le').toString('base64')], { encoding: 'utf8', windowsHide: true });
  console.log(output.trim());
  if (remove) return;
  const result = await launch();
  console.log(result.started ? 'EF Studio launched in the background.' : 'Port ' + result.port + ' is already in use; the existing process was left running.');
  console.log('Automatic launch: when this Windows user signs in, including after a restart.');
  console.log('Original StarNet station: http://127.0.0.1:' + result.port + '/');
  console.log('EF task page: http://127.0.0.1:' + result.port + '/ef/');
  console.log('Startup log: ' + result.logPath);
}
if (require.main === module) install().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { installationScript, psQuote };
