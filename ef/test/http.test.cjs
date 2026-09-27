'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { makeRun, createStreamParser } = require('../../frontend/ef/core.js');
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test('real isolated runtime serves EF, protects APIs, streams a test-provider run and saves history', { timeout: 45000 }, async () => {
  // Local fixture only: no real provider keys, paid calls, or user services.
  let providerCalls = 0;
  const provider = http.createServer((req, res) => {
    if (req.url.includes('/models')) { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ data: [{ id: 'test/model', context_length: 16000, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] }] })); }
    if (req.url.includes('/auth/key')) { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ data: { label: 'test fixture' } })); }
    if (req.url.includes('/chat/completions')) {
      providerCalls++; let raw = ''; req.on('data', b => raw += b); req.on('end', () => {
        if (raw.includes('EF_TEST_FAILURE')) { res.writeHead(401, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: { message: 'Test provider rejected this run' } })); }
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'EF_TEST_RESPONSE' } }] }) + '\n\n');
        res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cost: 0 } }) + '\n\n');
        res.end('data: [DONE]\n\n');
      }); return;
    }
    res.writeHead(404); res.end();
  });
  const providerPort = await listen(provider);
  const reserve = net.createServer(); const port = await listen(reserve); await new Promise(resolve => reserve.close(resolve));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ef-studio-test-'));
  const repo = path.resolve(__dirname, '../..'); let logs = '';
  const child = spawn(process.execPath, [path.join(repo, 'sidecar/index.js')], {
    cwd: repo, env: {
      PATH: process.env.PATH, SystemRoot: process.env.SystemRoot || '',
      NODE_PATH: path.join(repo, 'ef/node_modules'),
      STARNET_EF_STUDIO: '1', STARNET_PORT: String(port), STARNET_WORKSPACES: path.join(root, 'workspaces'),
      STARNET_OPENROUTER_BASE: `http://127.0.0.1:${providerPort}/api/v1`,
      STARNET_LIVE_PRICES: '0', STARNET_CRON_ENABLED: '0', STARNET_NIGHTSHIFT_ENABLED: '0',
    }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', b => { logs = (logs + b).slice(-12000); }); child.stderr.on('data', b => { logs = (logs + b).slice(-12000); });
  const base = `http://127.0.0.1:${port}`;
  try {
    let ready = false;
    for (let n = 0; n < 100; n++) {
      if (child.exitCode !== null) throw new Error('Runtime failed: ' + logs);
      try { ready = (await fetch(base + '/api/health')).ok; } catch (_) {}
      if (ready) break; await delay(100);
    }
    assert.ok(ready, 'Runtime must become healthy: ' + logs);
    const html = await (await fetch(base + '/ef/')).text();
    assert.match(html, /Agent Studio · EF Ventures/);
    const match = html.match(/window\.__STARNET_API_TOKEN__=("[^"]+")/); assert.ok(match, 'same-origin page receives launch token');
    const token = JSON.parse(match[1]); const headers = { 'Content-Type': 'application/json', 'x-starnet-token': token };
    for (const route of ['/ef/app.js', '/ef/core.js', '/ef/studio.css', '/']) assert.equal((await fetch(base + route)).status, 200, route);
    for (const route of ['/index.html', '/assets/station.png', '/agent-station-demo.html']) assert.equal((await fetch(base + route)).status, 404, route);
    assert.equal((await fetch(base + '/api/runtime/agent')).status, 403);
    const badHostStatus = await new Promise((resolve, reject) => { const req = http.get(base + '/ef/', { headers: { Host: 'untrusted.example' } }, res => { res.resume(); resolve(res.statusCode); }); req.on('error', reject); });
    assert.equal(badHostStatus, 403);
    assert.equal((await fetch(base + '/api/runtime/agent', { headers: { ...headers, Origin: 'https://untrusted.example' } })).status, 403);
    const runtime = await (await fetch(base + '/api/runtime/agent', { headers })).json(); assert.deepEqual(runtime.agents, []);
    assert.equal(providerCalls, 0, 'Opening preview must not generate paid/model work');
    const validate = await fetch(base + '/api/providers/validate', { method: 'POST', headers, body: JSON.stringify({ provider: 'openrouter', key: 'ef-test-key-not-real' }) });
    assert.equal((await validate.json()).credentialVerified, true);
    async function run(prompt) {
      const response = await fetch(base + '/api/run', { method: 'POST', headers, body: JSON.stringify(makeRun({ model: 'test/model', provider: 'openrouter', prompt, key: 'ef-test-key-not-real', capabilities: [] })) });
      assert.equal(response.status, 200); const events = []; const parser = createStreamParser(e => events.push(e)); parser.push(await response.text()); parser.finish(); return events;
    }
    const events = await run('Please reply with a brief greeting for this isolated preview test.');
    assert.ok(events.some(e => e.name === 'agent.token' && e.payload.delta.includes('EF_TEST_RESPONSE')), JSON.stringify(events));
    assert.equal(events.filter(e => e.name === 'agent.run.end' && e.payload.reason === 'done').length, 1);
    const failed = await run('EF_TEST_FAILURE');
    assert.ok(failed.some(e => e.name === 'agent.run.error'));
    assert.ok(!failed.some(e => e.name === 'agent.run.end' && e.payload.reason === 'done'));
    const history = await (await fetch(base + '/api/runs?agent=*&limit=12', { headers })).json();
    assert.ok(history.runs.length >= 2, 'run history persists attempts');
    console.log('Verified EF static routes, token/origin/host guards, provider validation, success/failure streaming, and persisted run history. Model responses came from a local test fixture.');
  } finally {
    const exited = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGTERM');
    await Promise.race([exited, delay(1500)]); if (child.exitCode === null) child.kill('SIGKILL');
    provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
