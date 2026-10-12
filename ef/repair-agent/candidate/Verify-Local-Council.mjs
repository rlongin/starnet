import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
export function chooseModel(tags, preferred = 'qwen3:8b') {
  const names = (tags.models || []).map(m => m.name || m.model).filter(Boolean);
  if (names.includes(preferred)) return preferred;
  throw Error('Configured model ' + preferred + ' is not installed at this endpoint. No model was downloaded or changed.');
}
export function checkEvents(text) {
  const events = text.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  const end = events.findLast(e => e.name === 'agent.run.end');
  const output = events.filter(e => e.name === 'agent.token').map(e => e.payload?.delta || '').join('').trim();
  if (!end || end.payload?.reason !== 'done' || !output) {
    throw Error('Local agent result: ' + JSON.stringify({reason:end?.payload?.reason || 'missing completion',output:output.slice(0,500)}));
  }
  return { output, completed: true };
}
export async function verify(stationRoot, baseUrl = 'http://127.0.0.1:11434/v1', preferredModel = 'qwen3:8b') {
  const endpoint = new URL(baseUrl);
  if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw Error('Only credential-free loopback Ollama is allowed');
  const tagsResponse = await fetch(endpoint.origin + '/api/tags', { signal: AbortSignal.timeout(10000) });
  if (!tagsResponse.ok) throw Error('Local Ollama is unavailable. Existing AI services were left untouched.');
  const model = chooseModel(await tagsResponse.json(), preferredModel);
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'ef-council-acceptance-'));
  const listener = net.createServer();
  await new Promise(r => listener.listen(0, '127.0.0.1', r));
  const port = listener.address().port;
  await new Promise(r => listener.close(r));
  const token = crypto.randomBytes(32).toString('hex');
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(STARNET_|SKYNET_|EF_COUNCIL_|EF_AI_RECOVERY)/.test(k)));
  Object.assign(env, {
    NODE_PATH: [path.join(stationRoot, 'node_modules'), path.join(stationRoot, 'ef', 'node_modules'), process.env.NODE_PATH].filter(Boolean).join(path.delimiter),
    STARNET_PORT: String(port), STARNET_API_TOKEN: token,
    STARNET_WORKSPACES: path.join(folder, 'workspaces'), STARNET_EF_STUDIO: '1',
    STARNET_CRON_ENABLED: '0', STARNET_NIGHTSHIFT_ENABLED: '0', STARNET_LIVE_PRICES: '0',
    STARNET_CLOUD_URL: '', STARNET_CLOUD_LIVE: '0', OLLAMA_BASE_URL: baseUrl,
  });
  const logPath = path.join(folder, 'runtime.log');
  const fd = fs.openSync(logPath, 'a');
  let child;
  try { child = spawn(process.execPath, [path.join(stationRoot, 'sidecar', 'index.js')], { env, cwd: stationRoot, windowsHide: true, stdio: ['ignore', fd, fd] }); }
  finally { fs.closeSync(fd); }
  let spawnError;
  child.on('error', e => { spawnError = e; });
  const base = 'http://127.0.0.1:' + port;
  const headers = { 'x-starnet-token': token, 'content-type': 'application/json', origin: base };
  try {
    let ready = false;
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline && child.exitCode === null && !spawnError) {
      try { const h = await fetch(base + '/api/health', { headers, signal: AbortSignal.timeout(1000) }); if (h.ok && (await h.text()).trim() === 'ok') { ready = true; break; } } catch {}
      await new Promise(r => setTimeout(r, 250));
    }
    if (!ready) throw Error('Installed StarNet runtime did not start. Local acceptance log: ' + logPath);
    const r = await fetch(base + '/api/run', {
      method: 'POST', headers, signal: AbortSignal.timeout(300000),
      body: JSON.stringify({ provider: 'ollama', model, baseUrl, agentId: 'agent', internal: true,
        reasoningEffort: 'none', system: 'Reply to the user in English. Reply with exactly COUNCIL_LOCAL_OK.',
        messages: [{ role: 'user', content: 'Confirm the local Council connection. Reply exactly COUNCIL_LOCAL_OK.' }] }),
    });
    if (!r.ok) throw Error('Actual StarNet local run returned HTTP ' + r.status + '. Log: ' + logPath);
    const text = await r.text();
    fs.writeFileSync(path.join(folder, 'response.ndjson'), text);
    checkEvents(text);
    return { ok: true, provider: 'ollama', model, baseUrl, actualRuntimeResponse: 'PASS', logPath };
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await Promise.race([new Promise(r => child.once('exit', r)), new Promise(r => setTimeout(r, 3000))]);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Positional endpoint/model preserve the installed configuration, including 11435.
  // A failed endpoint must not cause a silent move to a different Ollama service.
  verify(path.resolve(process.argv[2] || '.'), process.argv[3] || process.env.EF_COUNCIL_LOCAL_BASE_URL || undefined,
    process.argv[4] || process.env.EF_COUNCIL_LOCAL_MODEL || undefined)
    .then(r => console.log(JSON.stringify(r))).catch(e => { console.error(e.message); process.exitCode = 1; });
}
