'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { launch, portInUse } = require('../start-background.cjs');
const { installationScript, psQuote } = require('../install-windows-startup.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ef-login-test-'));
  const directory = path.join(root, 'ef');
  fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, 'start.cjs'),
    "require('node:fs').writeFileSync('launched.json', JSON.stringify({cwd: process.cwd(), marker: process.env.EF_TEST_MARKER}));");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, directory, env: { ...process.env, EF_STUDIO_PORT: '18797', EF_STUDIO_DATA: path.join(root, 'data'), EF_TEST_MARKER: 'isolated' } };
}
test('occupied port leaves existing process untouched and does not spawn', async t => {
  const f = fixture(t);
  const result = await launch({ ...f, probe: async () => true,
    spawnProcess: () => { throw new Error('Must not spawn'); } });
  assert.equal(result.started, false);
  assert.match(fs.readFileSync(result.logPath, 'utf8'), /did not launch another/);
});
test('free port launches the selected checkout in the background with a log', async t => {
  const f = fixture(t);
  const result = await launch({ ...f, probe: async () => false });
  assert.equal(result.started, true);
  const receipt = path.join(f.root, 'launched.json');
  for (let i = 0; i < 100 && !fs.existsSync(receipt); i++) await new Promise(r => setTimeout(r, 20));
  assert.deepEqual(JSON.parse(fs.readFileSync(receipt, 'utf8')), { cwd: f.root, marker: 'isolated' });
  assert.match(fs.readFileSync(result.logPath, 'utf8'), /Started EF launcher/);
});
test('port probe distinguishes an actual listener from a closed port', async () => {
  const server = net.createServer(socket => socket.end());
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try { assert.equal(await portInUse(port), true); }
  finally { await new Promise(resolve => server.close(resolve)); }
  assert.equal(await portInUse(port), false);
});
test('invalid port fails before probing or launching', async t => {
  const f = fixture(t);
  await assert.rejects(launch({ ...f, env: { ...f.env, EF_STUDIO_PORT: 'bad' } }), /Invalid/);
});
test('shortcut command preserves spaces and apostrophes without changing execution policy', () => {
  const directory = "/Users/Ric's Documents/starnet/ef";
  const node = '/Program Files/nodejs/node.exe';
  const script = installationScript({ directory, node });
  const match = script.match(/-EncodedCommand ([A-Za-z0-9+/=]+)/);
  assert.ok(match);
  const decoded = Buffer.from(match[1], 'base64').toString('utf16le');
  assert.equal(decoded, '& ' + psQuote(node) + ' ' + psQuote(path.join(directory, 'start-background.cjs')));
  assert.ok(script.includes("GetFolderPath('Startup')"));
  assert.ok(script.includes('Startup shortcut verification failed'));
  assert.ok(!script.includes('ExecutionPolicy'));
});
test('removal is limited to the managed shortcut and never stops processes', () => {
  const script = installationScript({ remove: true });
  assert.ok(script.includes('An unrelated EF Agent Studio shortcut already exists'));
  assert.ok(script.includes('Remove-Item -LiteralPath $shortcutPath'));
  assert.ok(!script.includes('Stop-Process'));
  assert.ok(!script.includes('$shortcut.Save()'));
});
