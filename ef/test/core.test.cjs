'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createStreamParser, runLabel, makeRun } = require('../../frontend/ef/core.js');
test('stream decoder keeps partial frames and final events without a newline', () => {
  const received = []; const stream = createStreamParser(e => received.push(e));
  stream.push('{"name":"agent.token","pay');
  stream.push('load":{"delta":"Hi"}}\n{"name":"agent.run.end","payload":{"reason":"done"}}');
  stream.finish(); assert.equal(received[0].payload.delta, 'Hi'); assert.equal(received[1].payload.reason, 'done');
});
test('malformed or oversized events are errors, not success', () => {
  assert.throws(() => createStreamParser(() => {}).push('not-json\n'));
  assert.throws(() => createStreamParser(() => {}).push('{"fake":true}\n'));
  assert.throws(() => createStreamParser(() => {}).push('x'.repeat(4 * 1024 * 1024 + 1)));
});
test('non-success runtime outcomes never display Completed', () => {
  for (const reason of ['error', 'budget', 'max_iters', 'cancelled', 'clarifying', 'empty', 'refusal', undefined]) assert.notEqual(runLabel(reason), 'Completed');
  assert.equal(runLabel('done'), 'Completed');
});
test('task requires input and grants only explicit supported capabilities', () => {
  assert.throws(() => makeRun({ model: 'a', prompt: '' }));
  assert.throws(() => makeRun({ model: '', prompt: 'a' }));
  const run = makeRun({ model: ' model ', prompt: ' task ', provider: 'openrouter', capabilities: ['dish', 'workbench', 'cabinet'] });
  assert.deepEqual(run.placed, ['dish', 'cabinet']); assert.equal(run.messages[0].content, 'task'); assert.equal(run.model, 'model');
  assert.deepEqual(makeRun({ model: 'a', prompt: 'b' }).placed, []);
});
