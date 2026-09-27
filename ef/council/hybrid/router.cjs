'use strict';
// One router per private station. The cloud station remains the only task/tool executor.
const http = require('node:http');
const crypto = require('node:crypto');
const { routerConfiguration, authorized, readJSON } = require('./config.cjs');
const MODEL = 'ef-hybrid';
function validCompletion(value) {
  const c = value?.choices;
  if (!Array.isArray(c) || c.length !== 1 || !c[0].message || c[0].message.role !== 'assistant') return false;
  const m = c[0].message;
  if (!['stop', 'tool_calls', 'length', 'content_filter'].includes(c[0].finish_reason)) return false;
  if (m.content != null && typeof m.content !== 'string') return false;
  if (m.tool_calls != null && (!Array.isArray(m.tool_calls) || m.tool_calls.some(t =>
    !t.id || t.type !== 'function' || typeof t.function?.name !== 'string' || typeof t.function?.arguments !== 'string'))) return false;
  return typeof m.content === 'string' || (Array.isArray(m.tool_calls) && m.tool_calls.length > 0);
}
function createRouter(config, { fetchImpl = fetch } = {}) {
  const jobs = new Map(); let poll = null; let active = 0;
  const stats = { local: 0, cloud: 0, failed: 0 };
  const publicHost = new URL(config.publicOrigin).host;
  function reply(res, code, value) {
    if (res.destroyed || res.writableEnded) return;
    res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(value === undefined ? '' : JSON.stringify(value));
  }
  function error(res, code, message) {
    const value = { error: { message, type: 'hybrid_error', code: String(code) } };
    if (res.headersSent) { if (!res.destroyed) res.end('data: ' + JSON.stringify(value) + '\n\n'); }
    else reply(res, code, value);
  }
  function releasePoll() {
    const p = poll; poll = null;
    if (p) clearTimeout(p.timer);
    return p;
  }
  function localCompletion(body, signal) {
    if (signal.aborted) return Promise.reject(Error('Caller cancelled'));
    const p = releasePoll();
    if (!p || p.res.destroyed) return Promise.reject(Error('No idle local worker'));
    return new Promise((resolve, reject) => {
      const id = crypto.randomBytes(32).toString('base64url');
      const cleanup = () => { clearTimeout(timer); jobs.delete(id); signal.removeEventListener('abort', abort); };
      const abort = () => { cleanup(); reject(Error('Caller cancelled')); };
      const timer = setTimeout(() => { cleanup(); reject(Error('Local model timed out')); }, config.localMs);
      jobs.set(id, { resolve(value) { cleanup(); resolve(value); }, reject() { cleanup(); reject(Error('Local model failed')); } });
      signal.addEventListener('abort', abort, { once: true });
      reply(p.res, 200, { id, timeoutMs: config.localMs, request: body });
    });
  }
  async function cloudCompletion(body, signal) {
    if (!config.cloudEnabled) throw Error('PC unavailable; cloud fallback is disabled');
    const r = await fetchImpl(config.cloudUrl, { method: 'POST', redirect: 'error',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + config.cloudKey },
      body: JSON.stringify({ ...body, model: config.cloudModel }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(config.cloudMs)]) });
    if (!r.ok) { await r.body?.cancel(); throw Error('Cloud provider rejected the request'); }
    const value = await readJSON(r.body, 8 * 1024 * 1024);
    if (!validCompletion(value)) throw Error('Cloud provider returned an incomplete response');
    return value;
  }
  function finish(res, value, source, stream) {
    // A complete model response is selected before ANY tool call/content reaches StarNet.
    // The router never executes tool calls, and never retries a StarNet task.
    const output = { ...value, model: MODEL, ef_backend: source };
    if (!stream) return reply(res, 200, output);
    const choice = value.choices[0]; const message = choice.message;
    const delta = { ...message };
    if (delta.tool_calls) delta.tool_calls = delta.tool_calls.map((t, index) => ({ ...t, index }));
    const base = { id: value.id || 'chatcmpl-' + crypto.randomUUID(), object: 'chat.completion.chunk', created: value.created || Math.floor(Date.now() / 1000), model: MODEL, ef_backend: source };
    res.write('data: ' + JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] }) + '\n\n');
    res.write('data: ' + JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: choice.finish_reason }], ...(value.usage ? { usage: value.usage } : {}) }) + '\n\n');
    res.end('data: [DONE]\n\n');
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    // Service-to-service API only; no browser cookies, CORS or browser origins.
    if (req.headers.origin || req.headers.cookie) return error(res, 403, 'Browser access is not supported');
    const localHost = '127.0.0.1:' + server.address().port;
    if (![publicHost, localHost].includes(req.headers.host)) return error(res, 403, 'Invalid host');
    const workerRoute = req.url.startsWith('/worker/');
    if (!authorized(req.headers.authorization, workerRoute ? config.bridgeKey : config.stationKey)) return error(res, 401, 'Unauthorized');
    // Even with the station key, never serve model routes through the public TLS hostname.
    if (!workerRoute && req.headers.host !== localHost) return error(res, 403, 'Model API is loopback only');
    try {
      if (req.url === '/worker/poll' && req.method === 'POST') {
        if (poll || jobs.size) return reply(res, 409, { error: 'Worker already active' });
        const p = { res, timer: setTimeout(() => { if (poll === p) releasePoll(); reply(res, 204); }, 25000) };
        poll = p; req.resume();
        res.once('close', () => { if (poll === p) releasePoll(); });
        return;
      }
      const result = req.url.match(/^\/worker\/result\/([A-Za-z0-9_-]{43})$/);
      if (result && req.method === 'POST') {
        const value = await readJSON(req, 8 * 1024 * 1024);
        const job = jobs.get(result[1]);
        if (!job) return reply(res, 410, { error: 'Job expired or cancelled' });
        if (value.failed === true || !validCompletion(value.completion)) job.reject();
        else job.resolve(value.completion);
        return reply(res, 200, { accepted: true });
      }
      if (req.url === '/v1/models' && req.method === 'GET') return reply(res, 200, { object: 'list', data: [{ id: MODEL, object: 'model', name: 'EF Hybrid — PC first / cloud fallback', context_length: config.contextLength, max_completion_tokens: config.maxTokens, supported_parameters: ['tools'], pricing: null }] });
      if (req.url === '/status' && req.method === 'GET') return reply(res, 200, { localReady: !!poll, localBusy: jobs.size > 0, cloudEnabled: config.cloudEnabled, active, ...stats });
      if (req.url !== '/v1/chat/completions' || req.method !== 'POST') return error(res, 404, 'Not found');
      if (active >= config.maxInFlight) { req.resume(); return error(res, 429, 'Station model capacity reached'); }
      active++;
      const controller = new AbortController(); let keepAlive;
      res.once('close', () => controller.abort());
      try {
        const input = await readJSON(req);
        if (input.model !== MODEL || !Array.isArray(input.messages) || !input.messages.length || (input.n != null && input.n !== 1) || (input.stream != null && typeof input.stream !== 'boolean')) return error(res, 400, 'Use ef-hybrid, messages, and one completion');
        const ceiling = input.max_completion_tokens ?? input.max_tokens ?? config.maxTokens;
        if (!Number.isInteger(ceiling) || ceiling < 1) return error(res, 400, 'Invalid output token limit');
        // Deliberate allowlist: no arbitrary upstream URLs, built-in cloud tools, or credential overrides.
        const body = { model: MODEL, messages: input.messages, stream: false, max_tokens: Math.min(ceiling, config.maxTokens), n: 1 };
        for (const name of ['tools', 'tool_choice', 'temperature', 'top_p', 'stop', 'response_format', 'parallel_tool_calls', 'seed']) if (input[name] !== undefined) body[name] = input[name];
        if (body.tools && (!Array.isArray(body.tools) || body.tools.some(t => t?.type !== 'function'))) return error(res, 400, 'Only function declarations are supported');
        if (input.stream) {
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'X-Accel-Buffering': 'no' });
          res.write(': waiting for model\n\n');
          keepAlive = setInterval(() => { if (!res.destroyed) res.write(': waiting for model\n\n'); }, 10000);
        }
        let value, source;
        try { value = await localCompletion(body, controller.signal); source = 'local'; }
        catch {
          if (controller.signal.aborted) return;
          value = await cloudCompletion(body, controller.signal); source = 'cloud';
        }
        if (controller.signal.aborted) return;
        stats[source]++; finish(res, value, source, input.stream);
      } catch {
        if (!controller.signal.aborted) { stats.failed++; error(res, 503, config.cloudEnabled ? 'No model completed the request. Check router and provider availability.' : 'PC unavailable; cloud fallback is disabled.'); }
      } finally { active--; clearInterval(keepAlive); }
    } catch { error(res, 400, 'Invalid request'); }
  });
  server.requestTimeout = 15000;
  server.on('close', () => { const p = releasePoll(); if (p) p.res.destroy(); for (const job of [...jobs.values()]) job.reject(); });
  return server;
}
if (require.main === module) {
  const config = routerConfiguration();
  const server = createRouter(config);
  server.listen(config.port, '127.0.0.1', () => console.log('EF hybrid model router ready on loopback port ' + config.port));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { server.closeAllConnections(); server.close(); });
}
module.exports = { createRouter, validCompletion, MODEL };
