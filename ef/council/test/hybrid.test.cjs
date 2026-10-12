'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { setTimeout: delay } = require('node:timers/promises');
const { createRouter, validCompletion } = require('../hybrid/router.cjs');
const { runBridge } = require('../hybrid/pc-bridge.cjs');
const { routerConfiguration, bridgeConfiguration } = require('../hybrid/config.cjs');
const listen = s => new Promise(resolve => s.listen(0, '127.0.0.1', () => resolve(s.address().port)));
const close = s => new Promise(resolve => { s.closeAllConnections(); s.close(resolve); });
const completed = (content, tool = false) => ({ id: 'fixture', object: 'chat.completion', choices: [{ index: 0,
  message: tool ? { role: 'assistant', content: null, tool_calls: [{ id: 'call_one', type: 'function', function: { name: 'inspect_file', arguments: '{"path":"example.txt"}' } }] } : { role: 'assistant', content },
  finish_reason: tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } });
const fixture = { publicOrigin: 'https://bridge.example.test', stationKey: 'S'.repeat(43), bridgeKey: 'B'.repeat(43),
  localMs: 1000, cloudMs: 1000, cloudEnabled: true, cloudKey: 'cloud-only-key', cloudModel: 'cloud-fixture', maxTokens: 2048, maxInFlight: 2, contextLength: 8192 };
async function setup(t, overrides = {}) {
  const cloudRequests = [], ollamaRequests = [];
  let localFail = false, cloudFail = false, localDelay = 0;
  const cloud = http.createServer(async (req, res) => {
    let raw = ''; for await (const b of req) raw += b;
    cloudRequests.push({ body: JSON.parse(raw), headers: req.headers });
    res.writeHead(cloudFail ? 500 : 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(completed('CLOUD', cloudRequests.at(-1).body.tools?.length > 0)));
  });
  const cloudPort = await listen(cloud);
  const ollama = http.createServer(async (req, res) => {
    if (req.url === '/api/tags') return res.end(JSON.stringify({ models: [{ name: 'qwen3:8b' }] }));
    let raw = ''; for await (const b of req) raw += b;
    ollamaRequests.push({ body: JSON.parse(raw), headers: req.headers });
    if (localDelay) await delay(localDelay);
    res.writeHead(localFail ? 500 : 200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(completed('LOCAL', ollamaRequests.at(-1).body.tools?.length > 0)));
  });
  const ollamaPort = await listen(ollama);
  const router = createRouter({ ...fixture, cloudUrl: `http://127.0.0.1:${cloudPort}/v1/chat/completions`, ...overrides });
  const port = await listen(router), base = `http://127.0.0.1:${port}`;
  const controllers = [], running = [];
  t.after(async () => { controllers.forEach(c => c.abort()); await Promise.all(running); await Promise.all([router, ollama, cloud].map(close)); });
  const call = (path, init = {}, key = fixture.stationKey) => {
    const headers = { Authorization: 'Bearer ' + key, ...init.headers };
    // Node fetch rewrites Host; use actual HTTP for host-spoof checks.
    if (headers.Host) return new Promise((resolve, reject) => {
      const req = http.request(base + path, { method: init.method || 'GET', headers }, res => {
        res.resume(); res.on('end', () => resolve({ status: res.statusCode }));
      }); req.on('error', reject); req.end(init.body);
    });
    return fetch(base + path, { ...init, headers });
  };
  const chat = (extra = {}, init = {}) => call('/v1/chat/completions', { method: 'POST', body: JSON.stringify({ model: 'ef-hybrid', messages: [{ role: 'user', content: 'fixture' }], ...extra }), ...init });
  const ready = async () => { for (let i = 0; i < 100; i++) { if ((await (await call('/status')).json()).localReady) return; await delay(10); } throw Error('Bridge not ready'); };
  const startBridge = async () => {
    const c = new AbortController(); controllers.push(c);
    running.push(runBridge({ publicOrigin: base, ollamaOrigin: `http://127.0.0.1:${ollamaPort}`, bridgeKey: fixture.bridgeKey, model: 'qwen3:8b' }, { signal: c.signal, retryMs: 10 }));
    await ready(); return c;
  };
  return { call, chat, ready, startBridge, cloudRequests, ollamaRequests,
    setLocalFailure: v => { localFail = v; }, setCloudFailure: v => { cloudFail = v; }, setLocalDelay: v => { localDelay = v; } };
}
test('PC first; offline cloud fallback; reconnect returns to local without moving station state', async t => {
  const f = await setup(t); const bridge = await f.startBridge();
  const local = await (await f.chat({ max_tokens: 9999 })).json();
  assert.equal(local.choices[0].message.content, 'LOCAL'); assert.equal(local.ef_backend, 'local'); assert.equal(f.cloudRequests.length, 0);
  assert.equal(f.ollamaRequests[0].body.max_tokens, 2048); assert.equal(f.ollamaRequests[0].body.model, 'qwen3:8b');
  assert.equal(f.ollamaRequests[0].headers.authorization, undefined, 'No bridge/cloud credential sent to Ollama');
  bridge.abort(); await delay(30);
  const cloud = await (await f.chat()).json(); assert.equal(cloud.ef_backend, 'cloud');
  assert.equal(f.cloudRequests.length, 1); assert.equal(f.cloudRequests[0].body.model, 'cloud-fixture');
  assert.equal(f.cloudRequests[0].headers.authorization, 'Bearer cloud-only-key');
  const next = await f.startBridge(); assert.equal((await (await f.chat()).json()).ef_backend, 'local'); next.abort();
});
test('local failure falls back once and tool calls remain one complete SSE response', async t => {
  const f = await setup(t); await f.startBridge(); f.setLocalFailure(true);
  const response = await f.chat({ stream: true, tools: [{ type: 'function', function: { name: 'inspect_file', parameters: { type: 'object' } } }] });
  const sse = await response.text();
  const events = sse.split('\n').filter(line => line.startsWith('data: {')).map(line => JSON.parse(line.slice(6)));
  assert.equal(events.filter(e => e.choices[0]?.delta?.tool_calls).length, 1);
  assert.equal(events[0].choices[0].delta.tool_calls[0].index, 0);
  assert.equal(events[1].choices[0].finish_reason, 'tool_calls'); assert.equal(events[1].usage.total_tokens, 6);
  assert.equal(f.cloudRequests.length, 1); assert.equal(f.ollamaRequests.length, 1);
  assert.match(sse, /\[DONE\]/);
});
test('timed out PC results are fenced out; a late result cannot overwrite cloud output', async t => {
  const f = await setup(t, { localMs: 60 });
  const pollPromise = f.call('/worker/poll', { method: 'POST' }, fixture.bridgeKey); await f.ready();
  const responsePromise = f.chat(); const job = await (await pollPromise).json();
  assert.equal((await (await responsePromise).json()).ef_backend, 'cloud');
  const late = await f.call('/worker/result/' + job.id, { method: 'POST', body: JSON.stringify({ completion: completed('LATE') }) }, fixture.bridgeKey);
  assert.equal(late.status, 410); assert.equal(f.cloudRequests.length, 1);
});
test('caller cancellation removes the local lease without starting paid fallback', async t => {
  const f = await setup(t);
  const pollPromise = f.call('/worker/poll', { method: 'POST' }, fixture.bridgeKey); await f.ready();
  const controller = new AbortController();
  const response = await f.chat({ stream: true }, { signal: controller.signal });
  const job = await (await pollPromise).json(); controller.abort(); await response.body.cancel().catch(() => {}); await delay(30);
  const late = await f.call('/worker/result/' + job.id, { method: 'POST', body: JSON.stringify({ completion: completed('LATE') }) }, fixture.bridgeKey);
  assert.equal(late.status, 410); assert.equal(f.cloudRequests.length, 0);
});
test('credentials, browser origins, host, private endpoints, capacity and unknown models are enforced', async t => {
  const f = await setup(t, { maxInFlight: 1 });
  assert.equal((await f.call('/v1/models', {}, 'wrong')).status, 401);
  assert.equal((await f.call('/v1/models', {}, fixture.bridgeKey)).status, 401);
  assert.equal((await f.call('/worker/poll', { method: 'POST' })).status, 401);
  assert.equal((await f.call('/v1/models', { headers: { Origin: 'https://nexus.example.test' } })).status, 403);
  assert.equal((await f.call('/v1/models', { headers: { Host: 'attacker.example.test' } })).status, 403);
  assert.equal((await f.call('/v1/models', { headers: { Host: 'bridge.example.test' } })).status, 403);
  assert.equal((await f.chat({ model: 'arbitrary-paid-model' })).status, 400);
  const pollPromise = f.call('/worker/poll', { method: 'POST' }, fixture.bridgeKey); await f.ready();
  const first = f.chat(); const job = await (await pollPromise).json();
  assert.equal((await f.chat()).status, 429);
  await f.call('/worker/result/' + job.id, { method: 'POST', body: JSON.stringify({ completion: completed('LOCAL') }) }, fixture.bridgeKey);
  await (await first).text();
  assert.equal((await f.call('/worker/result/' + job.id, { method: 'POST', body: '{}' }, fixture.bridgeKey)).status, 410);
});
test('cloud remains disabled unless explicitly enabled; failures do not look like successful replies', async t => {
  const f = await setup(t, { cloudEnabled: false });
  const response = await f.chat(); assert.equal(response.status, 503); assert.equal(f.cloudRequests.length, 0);
  const stream = await (await f.chat({ stream: true })).text(); assert.match(stream, /"error"/); assert.doesNotMatch(stream, /\[DONE\]/);
  assert.equal(validCompletion({ choices: [{ message: { role: 'assistant', content: 'partial' }, finish_reason: null }] }), false);
});
test('cloud errors are redacted and fail without recursive retries', async t => {
  const f = await setup(t); f.setCloudFailure(true);
  const response = await f.chat(); assert.equal(response.status, 503);
  const text = await response.text(); assert.doesNotMatch(text, /cloud-only-key|fixture/); assert.equal(f.cloudRequests.length, 1);
});
test('configuration refuses insecure transport and shared credentials', () => {
  const env = { HYBRID_STATION_KEY: fixture.stationKey, HYBRID_BRIDGE_KEY: fixture.bridgeKey, HYBRID_BRIDGE_ORIGIN: fixture.publicOrigin };
  assert.equal(routerConfiguration(env).cloudEnabled, false);
  assert.throws(() => routerConfiguration({ ...env, HYBRID_STATION_KEY: env.HYBRID_BRIDGE_KEY }));
  assert.throws(() => routerConfiguration({ ...env, HYBRID_BRIDGE_ORIGIN: 'http://example.test' }));
  assert.throws(() => routerConfiguration({ ...env, HYBRID_CLOUD_ENABLED: 'true' }));
  assert.throws(() => bridgeConfiguration({ ...env, HYBRID_OLLAMA_ORIGIN: 'http://192.168.1.2:11434' }));
  assert.throws(() => bridgeConfiguration({ ...env, HYBRID_OLLAMA_ORIGIN: 'http://127.0.0.1:11434/path' }));
  assert.equal(bridgeConfiguration(env).model, 'qwen3:8b');
});
