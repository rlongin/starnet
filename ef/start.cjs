'use strict';
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

// Give this pilot its own stores and port; never attach to a pre-existing station.
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(STARNET_|SKYNET_)/.test(k)));
const dataRoot = process.env.EF_STUDIO_DATA || path.join(os.homedir(), '.ef-agent-studio');
const port = Number(process.env.EF_STUDIO_PORT || 8797);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('EF_STUDIO_PORT must be 1024–65535');
Object.assign(env, {
  NODE_PATH: path.join(__dirname, 'node_modules'),
  STARNET_EF_STUDIO: '1',
  // Preserve the upstream renderer for this local checkout; EF isolation stays on.
  STARNET_EF_ORIGINAL_UI: process.env.EF_STUDIO_ORIGINAL_UI === '0' ? '0' : '1',
  STARNET_PORT: String(port),
  STARNET_WORKSPACES: path.join(path.resolve(dataRoot), 'workspaces'),
  STARNET_CRON_ENABLED: '0',
  STARNET_NIGHTSHIFT_ENABLED: '0',
  STARNET_LIVE_PRICES: '0',
  STARNET_CLOUD_URL: '',
  STARNET_CLOUD_LIVE: '0',
});
console.log(`EF Agent Studio preview: http://127.0.0.1:${port}/ef/`);
if (env.STARNET_EF_ORIGINAL_UI === '1') console.log(`Original StarNet station: http://127.0.0.1:${port}/`);
console.log('Private local workspace. Enter a provider key in the page only when you are ready to test.');
const child = spawn(process.execPath, [path.join(__dirname, '..', 'sidecar', 'index.js')], { env, stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('error', e => { console.error(e.message); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code == null ? 1 : code; });
