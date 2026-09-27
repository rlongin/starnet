'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test('local launcher serves the unchanged original station and EF with the same protected workspace', { timeout: 45000 }, async () => {
  const reserve = net.createServer();
  await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
  const port = reserve.address().port;
  await new Promise(resolve => reserve.close(resolve));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ef-original-test-'));
  const repo = path.resolve(__dirname, '../..');
  let logs = '';
  const child = spawn(process.execPath, [path.join(repo, 'ef/start.cjs')], {
    cwd: repo,
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot || '', EF_STUDIO_PORT: String(port), EF_STUDIO_DATA: root },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', b => { logs = (logs + b).slice(-16000); });
  child.stderr.on('data', b => { logs = (logs + b).slice(-16000); });
  const base = `http://127.0.0.1:${port}`;
  try {
    let ready = false;
    for (let n = 0; n < 150; n++) {
      if (child.exitCode !== null) throw new Error('Launcher failed: ' + logs);
      try { ready = (await fetch(base + '/api/health')).ok; } catch (_) {}
      if (ready) break;
      await delay(100);
    }
    assert.ok(ready, 'Local launcher must become healthy: ' + logs);
    const station = await (await fetch(base + '/')).text();
    const source = fs.readFileSync(path.join(repo, 'frontend/index.html'), 'utf8');
    const boot = /<script>window\.__STARNET_API_TOKEN__=("[^"]+");<\/script>\n/;
    const token = JSON.parse(station.match(boot)[1]);
    assert.equal(station.replace(boot, ''), source, 'Original HTML is unchanged except for runtime authentication');
    for (const route of ['/ef', '/ef/', '/ef/index.html']) {
      const ef = await (await fetch(base + route)).text();
      assert.match(ef, /Agent Studio · EF Ventures/);
      assert.equal(JSON.parse(ef.match(boot)[1]), token, 'Both views use the same runtime');
    }
    // Check every local script and stylesheet in the actual original entry point.
    const assets = [...source.matchAll(/<(?:script|link)\b[^>]*(?:src|href)="([^"]+)"/g)]
      .map(match => match[1]).filter(url => !/^(https?:|\/\/)/.test(url));
    for (let i = 0; i < assets.length; i += 12) {
      await Promise.all(assets.slice(i, i + 12).map(async asset => {
        const response = await fetch(new URL(asset, base + '/'));
        assert.equal(response.status, 200, asset);
        await response.arrayBuffer();
      }));
    }
    for (const route of ['/', '/index.html', '/assets/sprites/approved_android/rot_south.png']) {
      const status = await new Promise((resolve, reject) => {
        http.get(base + route, { headers: { Host: 'untrusted.example' } }, res => { res.resume(); resolve(res.statusCode); }).on('error', reject);
      });
      assert.equal(status, 403, 'Host restriction covers original assets');
    }
    assert.equal((await fetch(base + '/api/runtime/agent')).status, 403);
    const headers = { 'x-starnet-token': token };
    const runtime = await (await fetch(base + '/api/runtime/agent', { headers })).json();
    assert.deepEqual(runtime.agents, [], 'A fresh isolated workspace is not imported from another station');
    assert.equal((await fetch(base + '/api/runtime/agent', { headers: { ...headers, Origin: 'https://untrusted.example' } })).status, 403);
    assert.ok(fs.existsSync(path.join(root, 'workspaces')), 'Launcher uses the requested isolated workspace');
    console.log(`Verified unchanged station HTML, ${assets.length} original dependencies, shared EF token, and host/API protections.`);
  } finally {
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.kill('SIGTERM');
    await Promise.race([exited, delay(2500)]);
    if (child.exitCode === null) child.kill('SIGKILL');
    fs.rmSync(root, { recursive: true, force: true });
  }
});
