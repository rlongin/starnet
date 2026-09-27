'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(process.env.EF_APP_TEST_SOURCE || path.join(__dirname, '../../frontend/ef/app.js'), 'utf8');

async function boot(healthBody, healthStatus = 200, rosterStatus = 200) {
  const nodes = new Map();
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { textContent: '', disabled: id === 'run',
      classList: { toggle() {} }, addEventListener() {}, append() {}, replaceChildren() {} });
    return nodes.get(id);
  };
  const calls = [];
  const document = { getElementById: node, querySelectorAll: () => [],
    querySelector: () => node('topbar'), createElement: () => node('option') };
  const fetch = async route => {
    calls.push(route);
    if (route === '/api/health') return new Response(healthBody, { status: healthStatus });
    if (route === '/api/runtime/agent') return new Response(JSON.stringify(
      rosterStatus === 200 ? { agents: [] } : { error: 'Roster unavailable' }), { status: rosterStatus });
    if (route === '/api/runs?agent=*&limit=12') return new Response('{"runs":[]}');
    throw new Error('Unexpected route: ' + route);
  };
  vm.runInNewContext(source, { document, fetch, window: {
    EFStudioCore: {}, __STARNET_API_TOKEN__: 'test-token', addEventListener() {} } });
  await new Promise(resolve => setImmediate(resolve));
  return { node, calls };
}
test('plain-text healthy sidecar enables tasks and loads history', async () => {
  const { node, calls } = await boot('ok');
  assert.equal(node('run').disabled, false);
  assert.match(node('notice').textContent, /Local workspace connected/);
  assert.ok(calls.includes('/api/runs?agent=*&limit=12'));
});
test('degraded sidecar blocks tasks and preserves recovery error', async () => {
  const { node, calls } = await boot('degraded: workspace owner unavailable', 503);
  assert.equal(node('run').disabled, true);
  assert.match(node('notice').textContent, /workspace owner unavailable/);
  assert.deepEqual(calls, ['/api/health']);
});
test('unexpected successful health body cannot enable tasks', async () => {
  const { node, calls } = await boot('<html>not health</html>');
  assert.equal(node('run').disabled, true);
  assert.match(node('notice').textContent, /Unexpected runtime health response/);
  assert.deepEqual(calls, ['/api/health']);
});
test('healthy process with failed roster still blocks tasks', async () => {
  const { node } = await boot('ok', 200, 500);
  assert.equal(node('run').disabled, true);
  assert.match(node('notice').textContent, /Roster unavailable/);
});
