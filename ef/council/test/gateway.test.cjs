'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { configuration, createGateway, makeVerifier } = require('../gateway.cjs');
const ALICE = '11111111-1111-4111-8111-111111111111';
const BOB = '22222222-2222-4222-8222-222222222222';
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const close = server => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
function request(port, path, { method = 'GET', host = 'alice.example.test', origin, cookie, bearer, body, type } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { Host: host };
    if (origin) headers.Origin = origin;
    if (cookie) headers.Cookie = cookie;
    if (bearer) headers.Authorization = 'Bearer ' + bearer;
    if (body) { headers['Content-Type'] = type || 'application/x-www-form-urlencoded'; headers['Content-Length'] = Buffer.byteLength(body); }
    const req = http.request({ hostname: '127.0.0.1', port, path, method, headers }, res => {
      let text = ''; res.on('data', b => text += b); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on('error', reject); req.end(body);
  });
}
test('configuration rejects broad private access and missing/unsafe origins', () => {
  const env = { COUNCIL_PUBLIC_ORIGIN: 'https://alice.example.test', COUNCIL_NEXUS_ORIGIN: 'https://nexus.example.test',
    COUNCIL_SUPABASE_ORIGIN: 'https://project.supabase.co', COUNCIL_SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test', COUNCIL_ALLOWED_USER_IDS: ALICE };
  assert.equal(configuration(env).allowedUserIds.size, 1);
  assert.throws(() => configuration({ ...env, COUNCIL_ALLOWED_USER_IDS: ALICE + ',' + BOB }), /exactly one/);
  assert.throws(() => configuration({ ...env, COUNCIL_PUBLIC_ORIGIN: 'http://alice.example.test' }), /HTTPS/);
  assert.throws(() => configuration({ ...env, COUNCIL_PUBLIC_ORIGIN: env.COUNCIL_NEXUS_ORIGIN }), /separate/);
  assert.throws(() => configuration({ ...env, COUNCIL_ALLOWED_USER_IDS: '*' }), /UUIDs/);
  assert.throws(() => configuration({ ...env, COUNCIL_SUPABASE_PUBLISHABLE_KEY: 'sb_secret_dont-use' }), /publishable/);
});
test('identity is verified by Supabase before expiry claims are trusted', async () => {
  const token = 'header.' + Buffer.from(JSON.stringify({ exp: 2000 })).toString('base64url') + '.signature';
  const config = { supabaseOrigin: 'https://project.supabase.co', publishableKey: 'sb_publishable_test' };
  const verify = makeVerifier(config, async (url, options) => {
    assert.equal(url, config.supabaseOrigin + '/auth/v1/user');
    assert.equal(options.headers.Authorization, 'Bearer ' + token);
    assert.equal(options.redirect, 'error');
    return { ok: true, json: async () => ({ id: ALICE, is_anonymous: false }) };
  });
  assert.deepEqual(await verify(token), { id: ALICE, expiresAt: 2000000 });
  assert.equal(await makeVerifier(config, async () => ({ ok: false }))(token), null);
  assert.equal(await makeVerifier(config, async () => ({ ok: true, json: async () => ({ id: ALICE, is_anonymous: true }) }))(token), null);
});
test('two real HTTP gateways isolate members, origins, tickets, cookies and upstream credentials', async () => {
  let clock = 1000000, workerCalls = 0;
  const worker = http.createServer((req, res) => {
    workerCalls++;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ path: req.url, headers: req.headers }));
  });
  const workerPort = await listen(worker);
  const shared = { nexusOrigin: 'https://nexus.example.test', workerPort };
  const verifyUser = async token => token === 'alice' ? { id: ALICE, expiresAt: clock + 3600000 } : token === 'bob' ? { id: BOB, expiresAt: clock + 3600000 } : null;
  const aliceConfig = { ...shared, publicOrigin: 'https://alice.example.test', allowedUserIds: new Set([ALICE]) };
  const alice = createGateway(aliceConfig, { verifyUser, now: () => clock });
  const bob = createGateway({ ...shared, publicOrigin: 'https://bob.example.test', allowedUserIds: new Set([BOB]) }, { verifyUser, now: () => clock });
  const a = await listen(alice), b = await listen(bob);
  const launch = (bearer = 'alice') => request(a, '/__council/launch', { method: 'POST', origin: shared.nexusOrigin, bearer });
  const exchange = ticket => request(a, '/__council/session', { method: 'POST', origin: shared.nexusOrigin, body: 'ticket=' + ticket });
  try {
    assert.equal((await request(a, '/')).status, 401);
    assert.equal((await request(a, '/api/health')).status, 401, 'Worker health is also authenticated');
    assert.equal((await request(a, '/', { host: 'evil.test' })).status, 403);
    assert.equal((await launch('bad')).status, 401);
    assert.equal((await launch('bob')).status, 403, 'Bob cannot launch Alice’s private station');
    assert.equal((await request(a, '/__council/launch', { method: 'POST', bearer: 'alice', origin: 'https://evil.test' })).status, 403);
    assert.equal(workerCalls, 0, 'Unauthorized traffic never reaches the worker');
    const issued = await launch(); const ticket = JSON.parse(issued.text).ticket;
    assert.equal(issued.headers['access-control-allow-origin'], shared.nexusOrigin);
    assert.equal((await request(b, '/__council/session', { host: 'bob.example.test', method: 'POST', origin: shared.nexusOrigin, body: 'ticket=' + ticket })).status, 401, 'Ticket cannot cross station hosts');
    const accepted = await exchange(ticket);
    assert.equal(accepted.status, 303);
    const setCookie = accepted.headers['set-cookie'][0];
    for (const flag of ['Secure', 'HttpOnly', 'SameSite=None', 'Path=/']) assert.ok(setCookie.includes(flag));
    assert.ok(!setCookie.includes('Domain='));
    const cookie = setCookie.split(';')[0];
    assert.equal((await exchange(ticket)).status, 401, 'Ticket is single use');
    const proxied = await request(a, '/api/save?token=sidecar-token', { method: 'POST', origin: aliceConfig.publicOrigin, cookie, bearer: 'must-not-leak', body: '{}' });
    assert.equal(proxied.status, 200);
    const received = JSON.parse(proxied.text);
    assert.equal(received.path, '/api/save?token=sidecar-token');
    assert.equal(received.headers.origin, 'http://127.0.0.1:' + workerPort);
    assert.equal(received.headers.cookie, undefined);
    assert.equal(received.headers.authorization, undefined);
    assert.equal(proxied.headers['cache-control'], 'private, no-store');
    assert.ok(proxied.headers['content-security-policy'].includes(shared.nexusOrigin));
    assert.equal((await request(b, '/', { host: 'bob.example.test', cookie })).status, 401, 'Session cannot cross station hosts');
    assert.equal((await request(a, '/api/run', { method: 'POST', cookie })).status, 403);
    assert.equal((await request(a, '/api/run', { method: 'POST', cookie, origin: 'https://evil.test' })).status, 403);
    const fresh = JSON.parse((await launch()).text).ticket;
    clock += 30001;
    assert.equal((await exchange(fresh)).status, 401, 'Expired handoff rejected');
    aliceConfig.allowedUserIds.clear();
    assert.equal((await request(a, '/', { cookie })).status, 401, 'Removed assignment denies an existing session');
    aliceConfig.allowedUserIds.add(ALICE);
    clock += 900000;
    assert.equal((await request(a, '/', { cookie })).status, 401, 'Session expires');
    const nextCookie = (await exchange(JSON.parse((await launch()).text).ticket)).headers['set-cookie'][0].split(';')[0];
    assert.equal((await request(a, '/__council/logout', { method: 'POST', cookie: nextCookie, origin: shared.nexusOrigin })).status, 200);
    assert.equal((await request(a, '/', { cookie: nextCookie })).status, 401, 'Logout invalidates server session');
  } finally { await Promise.all([close(alice), close(bob), close(worker)]); }
});
