import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const restore = fs.readFileSync('ef/restore-known-good/Restore-StarNetKnownGood.ps1', 'utf8');
const verify = fs.readFileSync('ef/restore-known-good/Verify-StarNetKnownGood.ps1', 'utf8');
const supervisor = fs.readFileSync('ef/restore-known-good/Start-StarNetKnownGoodSupervisor.ps1', 'utf8');
const readme = fs.readFileSync('ef/restore-known-good/README.md', 'utf8');

test('restore pins known-good branches and model settings', () => {
  assert.match(restore, /backup\/council-station-working-20260928/);
  assert.match(restore, /24cf4da4f2e0e5a9374797bed17f087401859ed7/);
  assert.match(restore, /backup\/nexusrenn-golden-2026-09-24/);
  assert.match(restore, /390449bc1decc21c1c3334c44c0271437d9f071f/);
  assert.match(restore, /gpt-5\.5/);
  assert.match(restore, /qwen3:8b/);
  assert.match(restore, /nexus-primary/);
});

test('restore is audit-only unless Apply is passed and backs up before writes', () => {
  assert.match(restore, /\[switch\]\$Apply/);
  assert.match(restore, /if \(\$Apply\)/);
  assert.match(restore, /Backup-File \$cfgPath/);
  assert.match(restore, /restore-package/);
  assert.match(restore, /Copy-Item -LiteralPath \(Join-Path \$PSScriptRoot/);
  assert.match(restore, /Invoke-Checked -File "git" -ArgumentList @\("stash", "push", "-u"/);
  assert.match(restore, /Invoke-Checked -File "git" -ArgumentList @\("switch", "-C"/);
  assert.doesNotMatch(restore, /\[string\[\]\]\$Args/);
});

test('verification covers local llm, nexus renn, and council ports', () => {
  for (const token of ['api/tags', 'api/generate', 'v1/chat/completions', '8798', '8799', '4000']) {
    assert.match(verify, new RegExp(token.replace(/[/.]/g, m => '\\' + m)));
  }
});

test('supervisor does not kill preserved known-good council', () => {
  assert.doesNotMatch(supervisor, /Stop-Process|taskkill|docker restart/i);
  assert.match(supervisor, /start-recovery-gateway\.ps1/);
  assert.match(supervisor, /docker start nexus-ai-gateway/);
  assert.match(supervisor, /OLLAMA_HOST/);
  assert.match(supervisor, /ollama\.exe/);
});

test('readme states operational boundaries', () => {
  assert.match(readme, /does not erase workspace data/);
  assert.match(readme, /does not.*disable Bitdefender/);
  assert.match(readme, /does not.*change production Lovable publishing/);
});
