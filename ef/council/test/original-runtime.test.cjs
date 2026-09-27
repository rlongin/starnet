'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { createGateway } = require('../gateway.cjs');
const { createRouter } = require('../hybrid/router.cjs');
const { runBridge } = require('../hybrid/pc-bridge.cjs');
const { makeRun, createStreamParser } = require('../../../frontend/ef/core.js');
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test('original station assets, runtime token, PC/cloud model routing and history work through the gateway', { timeout: 45000 }, async () => {
  const repo = path.resolve(__dirname, '../../..');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'council-runtime-'));
  const model = http.createServer((req, res) => {
    if (req.url === '/api/tags') return res.end(JSON.stringify({ models: [{ name: 'qwen3:8b' }] }));
    if (req.url.includes('/models')) return res.end(JSON.stringify({ data: [{ id: 'test/model', context_length: 16000, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] }] }));
    if (req.url.includes('/chat/completions')) {
      let raw = ''; req.on('data', b => raw += b); req.on('end', () => {
        const request = JSON.parse(raw);
        if (request.stream === false) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: request.model === 'qwen3:8b' ? 'COUNCIL_LOCAL_OK' : 'COUNCIL_CLOUD_OK' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'COUNCIL_GATEWAY_OK' } }] }) + '\n\n');
        res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2, cost: 0 } }) + '\n\n');
        res.end('data: [DONE]\n\n');
      }); return;
    }
    res.writeHead(404); res.end();
  });
  const modelPort = await listen(model);
  const stationKey = 'S'.repeat(43), bridgeKey = 'B'.repeat(43);
  const router = createRouter({ publicOrigin: 'https://bridge.example.test', stationKey, bridgeKey,
    localMs: 3000, cloudMs: 3000, cloudEnabled: true, cloudUrl: `http://127.0.0.1:${modelPort}/v1/chat/completions`,
    cloudKey: 'fixture', cloudModel: 'cloud-fixture', maxTokens: 2048, maxInFlight: 2, contextLength: 8192 });
  const routerPort = await listen(router), routerBase = `http://127.0.0.1:${routerPort}`;
  const bridgeController = new AbortController();
  const bridge = runBridge({ publicOrigin: routerBase, bridgeKey, model: 'qwen3:8b', ollamaOrigin: `http://127.0.0.1:${modelPort}` }, { signal: bridgeController.signal, retryMs: 10 });
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
    let bridgeReady = false;
    for (let i = 0; i < 100; i++) {
      const status = await (await fetch(routerBase + '/status', { headers: { Authorization: 'Bearer ' + stationKey } })).json();
      if (status.localReady) { bridgeReady = true; break; } await delay(10);
    }
    assert.ok(bridgeReady, 'Outbound PC bridge ready');
    for (const expected of ['COUNCIL_LOCAL_OK', 'COUNCIL_CLOUD_OK']) {
      if (expected === 'COUNCIL_CLOUD_OK') { bridgeController.abort(); await bridge; await delay(30); }
      const body = { ...makeRun({ model: 'ef-hybrid', provider: 'custom', prompt: 'Say hello', key: stationKey, capabilities: [] }), baseUrl: routerBase + '/v1' };
      const run = await request('/api/run', { method: 'POST', headers, body: JSON.stringify(body) });
      assert.equal(run.status, 200);
      const events = []; const parser = createStreamParser(e => events.push(e)); parser.push(run.text); parser.finish();
      assert.ok(events.some(e => e.name === 'agent.token' && e.payload.delta.includes(expected)), run.text.slice(-4000));
      assert.ok(events.some(e => e.name === 'agent.run.end' && e.payload.reason === 'done'));
    }
    const history = await request('/api/runs?agent=*&limit=12', { headers });
    assert.ok(JSON.parse(history.text).runs.length >= 2);
    console.log(`Original station, ${assets.length} assets, PC and cloud model replies, and both task histories passed through gateway.`);
  } finally {
    const exited = new Promise(resolve => worker.once('exit', resolve)); worker.kill('SIGTERM');
    await Promise.race([exited, delay(1500)]); if (worker.exitCode === null) worker.kill('SIGKILL');
    bridgeController.abort(); await bridge;
    await Promise.all([gateway, router, model].map(server => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); })));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
