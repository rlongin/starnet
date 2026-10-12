'use strict';
// Exercise the real HTTP host: a member never sees the Windows owner's legacy save.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');

(async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ef-member-isolation-'));
  const legacy = path.join(temp, 'StarNet', 'workspaces');
  fs.mkdirSync(legacy, { recursive: true });
  const save = JSON.stringify({ version: 1, agentId: 'agent', doc: {
    schema: 'starnet.save', version: 5, updatedAt: 1000,
    agent: { id: 'agent', name: 'PRIVATE_HOST_STATION' },
    station: { rooms: [], props: [] }, workstreams: []
  }});
  fs.writeFileSync(path.join(legacy, 'agent.save.json'), save);
  const member = new SidecarFixture({ env: {
    LOCALAPPDATA: temp, APPDATA: temp, EF_NEXUS_MEMBER_NAMESPACE: 'a'.repeat(32)
  }});
  try {
    await member.start();
    const report = await member.json('GET', '/api/lineage/report');
    assert.equal(report.status, 200, report.text);
    assert.equal(report.body.recovery.recoverableCount, 0);
    assert.deepEqual(report.body.recovery.candidates, []);
    assert.ok(!report.text.includes('PRIVATE_HOST_STATION'));
    const response = await member.json('GET', '/api/save?agent=agent');
    assert.equal(response.body.save, null);
    assert.equal(response.body.lineage.onboardingAllowed, true);
    await member.restart();
    const again = await member.json('GET', '/api/lineage/report');
    assert.deepEqual(again.body.recovery.candidates, []);
    assert.equal(fs.readFileSync(path.join(legacy, 'agent.save.json'), 'utf8'), save);
    console.log('ef-member-recovery.http: PASS (host save excluded before and after member restart)');
  } finally {
    await member.dispose();
    fs.rmSync(temp, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
