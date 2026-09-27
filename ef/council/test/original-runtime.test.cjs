'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createGateway } = require('../gateway.cjs');
const { makeRun, createStreamParser } = require('../../../frontend/ef/core.js');
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test('original station assets, runtime token, streamed task and history work through the gateway', { timeout: 45000 }, async () => {
  const repo = path.resolve(__dirname, '../../..');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'council-runtime-'));
  const model = http.createServer((req, res) => {
    if (req.url.includes('/models')) return res.end(JSON.stringify({ data: [{ id: 'test/model', context_length: 16000, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] }] }));
    if (req.url.includes('/chat/completions')) {
      req.resume(); req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'COUNCIL_GATEWAY_OK' } }] }) + '\n\n');
        res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost: 0 } }) + '\n\n');
        res.end('data: [DONE]\n\n');
      }); return;
    }
    res.writeHead(404); res.end();
  });
  const modelPort = await listen(model);
  const reserve = http.createServer(); const workerPort = await listen(reserve); await new Promise(resolve => reserve.close(resolve));
  let logs = '';
  const worker = spawn(process.execPath, [path.join(repo, 'sidecar/index.js')], {
    cwd: repo, env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot || '', NODE_PATH: path.join(repo, 'ef/node_modules'),
      STARNET_EF_STUDIO: '1', STARNET_EF_ORIGINAL_UI: '1', STARNET_PORT: String(workerPort), STARNET_WORKSPACES: path.join(root, 'workspaces'),
      STARNET_LIVE_PRICES: '0', STARNET_CRON_ENABLED: '0', STARNET_NIGHTSHIFT_ENABLED: '0', STARNET_OPENROUTER_BASE: `http://127.0.0.1:${modelPort}/api/v1` },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  worker.stdout.on('data', b => { logs = (logs + b).slice(-12000); }); worker.stderr.on('data', b => { logs = (logs + b).slice(-12000); });
  const member = '11111111-1111-4111-8111-111111111111';
  const gateway = createGateway({ publicOrigin: 'https://station.example.test', nexusOrigin: 'https://nexus.example.test', workerPort, allowedUserIds: new Set([member]) },
    { verifyUser: async () => ({ id: member, expiresAt: Date.now() + 3600000 }) });
  const port = await listen(gateway);
  function request(route, options = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port, path: route, method: options.method || 'GET',
        headers: { Host: 'station.example.test', ...options.headers } }, res => {
        let text = ''; res.on('data', b => text += b); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
      }); req.on('error', reject); req.end(options.body);
    });
  }
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      if (worker.exitCode !== null) throw Error(logs);
      try { ready = (await fetch(`http://127.0.0.1:${workerPort}/api/health`)).ok; } catch {}
      if (ready) break; await delay(100);
    }
    assert.ok(ready, logs);
    const issued = await request('/__council/launch', { method: 'POST', headers: { Origin: 'https://nexus.example.test', Authorization: 'Bearer fixture' } });
    const accepted = await request('/__council/session', { method: 'POST', headers: { Origin: 'https://nexus.example.test', 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'ticket=' + JSON.parse(issued.text).ticket });
    const Cookie = accepted.headers['set-cookie'][0].split(';')[0];
    const original = await request('/', { headers: { Cookie } });
    assert.equal(original.status, 200); assert.match(original.text, /<title>STARNET<\/title>/);
    const token = JSON.parse(original.text.match(/window\.__STARNET_API_TOKEN__=("[^"]+")/)[1]);
    const assets = [...original.text.matchAll(/<(?:script|link)\b[^>]*(?:src|href)="([^"]+)"/g)].map(m => m[1]).filter(url => !/^(https?:|\/\/)/.test(url));
    for (let i = 0; i < assets.length; i += 12) await Promise.all(assets.slice(i, i + 12).map(async asset => assert.equal((await request('/' + asset.replace(/^\//, ''), { headers: { Cookie } })).status, 200, asset)));
    assert.equal((await request('/api/runtime/agent', { headers: { Cookie } })).status, 403, 'Sidecar token guard still applies behind gateway session');
    const headers = { Cookie, Origin: 'https://station.example.test', 'x-starnet-token': token, 'Content-Type': 'application/json' };
    const run = await request('/api/run', { method: 'POST', headers, body: JSON.stringify(makeRun({ model: 'test/model', provider: 'openrouter', prompt: 'Say hello', key: 'fixture', capabilities: [] })) });
    assert.equal(run.status, 200);
    const events = []; const parser = createStreamParser(e => events.push(e)); parser.push(run.text); parser.finish();
    assert.ok(events.some(e => e.name === 'agent.token' && e.payload.delta.includes('COUNCIL_GATEWAY_OK')));
    assert.ok(events.some(e => e.name === 'agent.run.end' && e.payload.reason === 'done'));
    const history = await request('/api/runs?agent=*&limit=12', { headers });
    assert.ok(JSON.parse(history.text).runs.length > 0);
    console.log(`Original station, ${assets.length} assets, authenticated model stream and persisted history passed through gateway.`);
  } finally {
    const exited = new Promise(resolve => worker.once('exit', resolve)); worker.kill('SIGTERM');
    await Promise.race([exited, delay(1500)]); if (worker.exitCode === null) worker.kill('SIGKILL');
    await Promise.all([gateway, model].map(server => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); })));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
