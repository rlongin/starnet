import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { findStation, agentArgs, codexVersion } from '../launch-agent.mjs';

test('launcher selects an actual checkout, not system32 or a guessed empty folder', () => {
 const profile = path.resolve('test-user');
 const expected = path.join(profile, 'Documents', 'GitHub', 'starnet');
 assert.equal(findStation(profile, p => p === path.join(expected, 'sidecar', 'index.js')), expected);
 assert.equal(findStation(profile, () => false), null);
});
test('local agent retains approval boundaries and explicit scope, including paths with spaces', () => {
 const args = agentArgs('C:\\Users\\Example User\\Documents\\GitHub\\starnet', 'C:\\state', 'C:\\Downloads\\Agent Kit', () => true);
 assert.equal(args[1], 'C:\\Users\\Example User\\Documents\\GitHub\\starnet');
 assert.equal(args[args.indexOf('--sandbox') + 1], 'workspace-write');
 assert.equal(args[args.indexOf('--ask-for-approval') + 1], 'on-request');
 assert.ok(args.includes('C:\\NexusAI\\Recovery'));
 assert.ok(!args.includes('--dangerously-bypass-approvals-and-sandbox'));
 assert.match(args.at(-1), /PROGRESS.md/);
 assert.match(args.at(-1), /Do not report fixed until the live acceptance gates pass/);
});
test('launcher pins the official CLI and does not change security configuration', () => {
 assert.equal(codexVersion, '0.160.1');
 const source = fs.readFileSync(new URL('../launch-agent.mjs', import.meta.url), 'utf8');
 assert.match(source, /@openai\/codex@/);
 assert.doesNotMatch(source, /Set-MpPreference|Add-MpPreference|Set-ExecutionPolicy|EncodedCommand/);
});
