'use strict';
(() => {
  const $ = id => document.getElementById(id);
  const { makeRun, createStreamParser, runLabel } = window.EFStudioCore;
  let connected = false, controller = null, runId = null, responseText = '', taskFailed = false;
  const token = window.__STARNET_API_TOKEN__;
  function notice(message, error = false) { $('notice').textContent = message; $('notice').classList.toggle('error', error); }
  async function api(route, body, signal) {
    const response = await fetch(route, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', 'x-starnet-token': token || '' },
      body: body === undefined ? undefined : JSON.stringify(body), signal, cache: 'no-store',
    });
    if (!response.ok) {
      const text = await response.text();
      let message = text;
      try { message = JSON.parse(text).error || text; } catch (_) {}
      throw new Error(message || `Request failed (${response.status})`);
    }
    return response;
  }
  async function json(route, body) {
    const data = await (await api(route, body)).json();
    if (data.ok === false) throw new Error(data.error || 'The runtime could not complete this request.');
    return data;
  }
  function activity(message) {
    const item = document.createElement('li'); item.textContent = message; $('activity').append(item);
    while ($('activity').children.length > 200) $('activity').firstChild.remove();
  }
  function button(label, action) { const b = document.createElement('button'); b.type = 'button'; b.textContent = label; b.addEventListener('click', action); return b; }
  async function showPermission(payload) {
    const id = runId;
    if (!id) throw new Error('Permission prompt arrived without a run ID. Stop and retry the task.');
    const card = document.createElement('section'); card.className = 'permission';
    const title = document.createElement('h3'); title.textContent = payload.tool === 'brief.ask' ? 'Your agent has a question' : `Permission requested: ${payload.tool}`;
    const description = document.createElement('p');
    let clarification = null;
    if (payload.tool === 'brief.ask') { try { clarification = JSON.parse(payload.argsSummary); } catch (_) {} }
    description.textContent = clarification ? clarification.question : `${payload.scope || 'access'} · ${payload.argsSummary || 'Review this action before allowing it.'}`;
    card.append(title, description);
    async function decide(route, values) {
      const controls = [...card.querySelectorAll('button, input')]; controls.forEach(b => { b.disabled = true; });
      try { await json(route, { runId: id, promptId: payload.promptId, ...values }); card.remove(); activity('Your decision was sent to the runtime.'); }
      catch (e) { controls.forEach(b => { b.disabled = false; }); notice(e.message, true); }
    }
    if (clarification) {
      const answer = document.createElement('input'); answer.placeholder = 'Your answer'; answer.setAttribute('aria-label', 'Answer your agent');
      for (const option of (clarification.options || []).slice(0, 6)) card.append(button(String(option), () => { answer.value = String(option); }));
      card.append(answer, button('Send answer', () => { if (answer.value.trim()) decide('/api/consent/answer', { answer: answer.value.trim(), receipt: true }); }));
    } else card.append(button('Allow once', () => decide('/api/consent', { decision: 'once' })));
    card.append(button('Deny', () => decide('/api/consent', { decision: 'deny' })));
    $('permissions').append(card);
    await json('/api/consent/ack', { runId: id, promptId: payload.promptId });
  }
  function eventReceived({ name, payload }) {
    if (payload.runId) runId = payload.runId;
    if (name === 'agent.run.start') { activity(`Started with ${payload.model}`); $('run-status').textContent = 'WORKING'; }
    else if (name === 'agent.token') { responseText += payload.delta || ''; $('output').textContent = responseText; }
    else if (name === 'agent.tool_call') activity(`Tool requested: ${payload.name}`);
    else if (name === 'agent.tool_result') activity(payload.ok && !payload.isError ? 'Tool finished.' : `Tool reported an error: ${payload.summary || 'see response'}`);
    else if (name === 'permission.prompt') { showPermission(payload).catch(e => notice(e.message, true)); $('run-status').textContent = 'NEEDS YOUR INPUT'; }
    else if (name === 'agent.run.error') { taskFailed = true; activity(payload.message); notice(payload.message, true); $('run-status').textContent = 'FAILED'; }
    else if (name === 'agent.run.end') {
      controller.sawEnd = true;
      $('run-status').textContent = taskFailed ? 'FAILED' : runLabel(payload.reason).toUpperCase();
      $('cost').textContent = Number.isFinite(payload.usd) ? `Reported run cost: $${payload.usd.toFixed(4)}` : 'Run cost not reported.';
      activity(`Outcome: ${runLabel(payload.reason)}`);
    }
  }
  async function history() {
    const box = $('history-list');
    try {
      const data = await json('/api/runs?agent=*&limit=12'); box.replaceChildren();
      if (!(data.runs || []).length) { box.textContent = 'No saved runs yet. Your completed attempts will appear here.'; return; }
      for (const run of data.runs) {
        const row = document.createElement('div'); row.className = 'history-row';
        const identity = document.createElement('span'); const label = document.createElement('strong'); label.textContent = run.agentId === 'agent' ? 'EF Guide' : run.agentId || 'Agent';
        const detail = document.createElement('small'); detail.textContent = run.runId || ''; identity.append(label, detail);
        const model = document.createElement('span'); model.textContent = run.model || 'Model not recorded';
        const state = document.createElement('span'); state.className = 'pill'; state.textContent = runLabel(run.reason);
        row.append(identity, model, state); box.append(row);
      }
    } catch (e) { box.textContent = `Could not load run history: ${e.message}`; }
  }
  async function connect() {
    try {
      if (!token) {
        notice('Design preview · Agent execution is unavailable until the dedicated runtime is connected. You can review the layout and task starters here.');
        $('check-provider').disabled = true; $('refresh').disabled = true;
        $('provider-key').disabled = true; $('provider-key').placeholder = 'Available in the connected app';
        $('provider-state').textContent = 'RUNTIME NOT CONNECTED';
        $('history-list').textContent = 'Run history will appear when the runtime is connected.';
        document.querySelector('.topbar .pill').textContent = 'DESIGN PREVIEW';
        return;
      }
      const health = await json('/api/health');
      if (health.degraded) throw new Error('The local runtime is in recovery mode. Check its terminal before running tasks.');
      const runtime = await json('/api/runtime/agent');
      for (const a of runtime.agents || []) {
        if (a.agentId === 'agent') continue;
        const option = document.createElement('option'); option.value = a.agentId; option.textContent = a.name; $('agent').append(option);
      }
      connected = true; $('run').disabled = false;
      notice('Local workspace connected. Choose your provider and model below, then start a task.');
      await history();
    } catch (e) { notice(e.message, true); $('history-list').textContent = 'History is unavailable while the runtime is disconnected.'; }
  }
  $('provider').addEventListener('change', () => { $('key-field').hidden = $('provider').value === 'ollama'; $('provider-state').textContent = 'NOT CHECKED'; });
  for (const id of ['model', 'provider-key']) $(id).addEventListener('input', () => { $('provider-state').textContent = 'NOT CHECKED'; });
  $('check-provider').addEventListener('click', async () => {
    const check = $('check-provider'); check.disabled = true; $('provider-state').textContent = 'CHECKING';
    try {
      const provider = $('provider').value;
      const data = await json(provider === 'ollama' ? '/api/providers/probe' : '/api/providers/validate', { provider, key: provider === 'ollama' ? '' : $('provider-key').value.trim() });
      if (!data.credentialVerified) throw new Error(data.error || 'Provider could not be verified. Check your key or local service.');
      $('provider-state').textContent = 'CONNECTION VERIFIED'; notice('Provider connection verified. Enter its model ID to run a task. This check did not generate a response.');
    } catch (e) { $('provider-state').textContent = 'NOT CONNECTED'; notice(e.message, true); }
    finally { check.disabled = false; }
  });
  document.querySelectorAll('[data-prompt]').forEach(b => b.addEventListener('click', () => { $('prompt').value = b.dataset.prompt; $('prompt').focus(); }));
  $('task-form').addEventListener('submit', async e => {
    e.preventDefault(); if (!connected || controller) return;
    let body;
    try {
      const provider = $('provider').value;
      if (provider === 'openrouter' && !$('provider-key').value.trim()) throw new Error('Enter your OpenRouter key in Connection first.');
      body = makeRun({ agentId: $('agent').value, provider, model: $('model').value, key: provider === 'ollama' ? '' : $('provider-key').value.trim(), prompt: $('prompt').value, capabilities: [...document.querySelectorAll('[name=capability]:checked')].map(x => x.value) });
    } catch (err) { notice(err.message, true); return; }
    controller = new AbortController(); runId = null; taskFailed = false; responseText = '';
    $('empty-output').hidden = true; $('output').hidden = false; $('output').textContent = ''; $('permissions').replaceChildren(); $('activity').replaceChildren();
    $('run').disabled = true; $('stop').hidden = false; $('download').disabled = true; $('run-status').textContent = 'STARTING'; $('cost').textContent = 'Waiting for runtime cost report.'; notice('Task started. Watch for questions or permission requests.');
    try {
      const response = await api('/api/run', body, controller.signal);
      const reader = response.body.getReader(); const decoder = new TextDecoder(); const parser = createStreamParser(eventReceived);
      for (;;) { const { value, done } = await reader.read(); if (done) break; parser.push(decoder.decode(value, { stream: true })); }
      parser.push(decoder.decode()); parser.finish();
      if (!controller.sawEnd) throw new Error('Connection ended before the runtime confirmed an outcome. Check run history before retrying.');
      if (!taskFailed) notice(`Task ended: ${$('run-status').textContent.toLowerCase()}.`);
    } catch (err) {
      const stopped = err.name === 'AbortError'; $('run-status').textContent = stopped ? 'STOP REQUESTED' : 'OUTCOME UNCONFIRMED';
      notice(stopped ? 'Stop requested. The disconnected stream cancels the run; check history for its final outcome.' : err.message, !stopped);
    } finally {
      controller = null; $('run').disabled = false; $('stop').hidden = true; $('download').disabled = !responseText; $('permissions').replaceChildren(); await history();
    }
  });
  $('stop').addEventListener('click', () => controller?.abort());
  $('refresh').addEventListener('click', history);
  $('download').addEventListener('click', () => {
    const blob = new Blob([responseText], { type: 'text/markdown;charset=utf-8' }); const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = 'ef-agent-response.md'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  window.addEventListener('beforeunload', () => controller?.abort());
  connect();
})();
