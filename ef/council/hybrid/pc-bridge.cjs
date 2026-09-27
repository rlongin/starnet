'use strict';
// Outbound-only. No listener, shell execution, model downloads, or desktop configuration changes.
const { setTimeout: delay } = require('node:timers/promises');
const { bridgeConfiguration, readJSON } = require('./config.cjs');
async function runBridge(config, { signal, fetchImpl = fetch, retryMs = 3000, onEvent = () => {} } = {}) {
  while (!signal?.aborted) {
    try {
      const probe = await fetchImpl(config.ollamaOrigin + '/api/tags', { redirect: 'error', signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(3000)]) });
      if (!probe.ok) throw Error('Ollama unavailable');
      const tags = await readJSON(probe.body);
      if (!tags.models?.some(m => m.name === config.model || m.model === config.model)) throw Error('Configured model is not installed');
      const poll = await fetchImpl(config.publicOrigin + '/worker/poll', { method: 'POST', redirect: 'error',
        headers: { Authorization: 'Bearer ' + config.bridgeKey },
        signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(30000)]) });
      if (poll.status === 204) continue;
      if (!poll.ok) { await poll.body?.cancel(); throw Error('Router unavailable'); }
      const job = await readJSON(poll.body);
      if (!/^[A-Za-z0-9_-]{43}$/.test(job.id) || !Number.isInteger(job.timeoutMs) || job.timeoutMs < 1 || job.timeoutMs > 300000 || !Array.isArray(job.request?.messages)) throw Error('Invalid job');
      let result;
      try {
        // The router selects a complete response. This worker never executes model tool calls.
        const completion = await fetchImpl(config.ollamaOrigin + '/v1/chat/completions', { method: 'POST', redirect: 'error',
          headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...job.request, model: config.model, stream: false }),
          signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(job.timeoutMs)]) });
        if (!completion.ok) { await completion.body?.cancel(); throw Error('Model failed'); }
        result = { completion: await readJSON(completion.body, 8 * 1024 * 1024) };
      } catch { result = { failed: true }; }
      if (signal?.aborted) break;
      const posted = await fetchImpl(config.publicOrigin + '/worker/result/' + job.id, { method: 'POST', redirect: 'error',
        headers: { Authorization: 'Bearer ' + config.bridgeKey, 'Content-Type': 'application/json' }, body: JSON.stringify(result),
        signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(15000)]) });
      await posted.body?.cancel();
      onEvent(posted.ok ? 'Local response delivered' : 'Local response no longer needed');
    } catch {
      if (signal?.aborted) break;
      onEvent('Waiting for router or local model');
      await delay(retryMs, undefined, { signal }).catch(() => {});
    }
  }
}
if (require.main === module) {
  const controller = new AbortController();
  for (const name of ['SIGINT', 'SIGTERM']) process.once(name, () => controller.abort());
  runBridge(bridgeConfiguration(), { signal: controller.signal, onEvent: message => console.log(new Date().toISOString() + ' ' + message) }).catch(() => { console.error('Bridge stopped'); process.exitCode = 1; });
}
module.exports = { runBridge };
