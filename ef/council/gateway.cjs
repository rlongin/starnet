'use strict';
// One gateway + one original station per isolated host. Never a shared-user sidecar.
const http = require('node:http');
const crypto = require('node:crypto');

const COOKIE = '__Host-ef_council';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function secureOrigin(value) {
  const u = new URL(value);
  if (u.protocol !== 'https:' || u.origin !== value || u.username || u.password) throw Error('Use an exact HTTPS origin');
  return u;
}
function configuration(env = process.env) {
  const publicOrigin = secureOrigin(env.COUNCIL_PUBLIC_ORIGIN);
  const nexusOrigin = secureOrigin(env.COUNCIL_NEXUS_ORIGIN);
  if (publicOrigin.origin === nexusOrigin.origin) throw Error('Station must have a separate origin');
  const supabaseOrigin = secureOrigin(env.COUNCIL_SUPABASE_ORIGIN);
  const publishableKey = env.COUNCIL_SUPABASE_PUBLISHABLE_KEY || '';
  if (!publishableKey || publishableKey.startsWith('sb_secret_')) throw Error('A Supabase publishable key is required');
  const allowedUserIds = new Set((env.COUNCIL_ALLOWED_USER_IDS || '').split(',').map(s => s.trim()).filter(Boolean));
  if (!allowedUserIds.size || [...allowedUserIds].some(id => !UUID.test(id))) throw Error('Configure explicit member UUIDs');
  const mode = env.COUNCIL_MODE || 'private';
  if (!['private', 'shared'].includes(mode) || (mode === 'private' && allowedUserIds.size !== 1)) throw Error('A private station must have exactly one owner');
  const workerPort = Number(env.COUNCIL_WORKER_PORT || 8787);
  const port = Number(env.COUNCIL_GATEWAY_PORT || 8898);
  if (![workerPort, port].every(p => Number.isInteger(p) && p >= 1024 && p <= 65535) || workerPort === port) throw Error('Invalid or conflicting ports');
  return { publicOrigin: publicOrigin.origin, nexusOrigin: nexusOrigin.origin, supabaseOrigin: supabaseOrigin.origin,
    publishableKey, allowedUserIds, workerPort, port, mode };
}
function makeVerifier(config, fetchImpl = fetch) {
  return async token => {
    if (!token || token.length > 12000) return null;
    const r = await fetchImpl(config.supabaseOrigin + '/auth/v1/user', {
      headers: { apikey: config.publishableKey, Authorization: 'Bearer ' + token },
      redirect: 'error', signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) return null;
    const user = await r.json();
    // Only inspect expiry after the Auth server has verified the JWT.
    let exp; try { exp = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).exp; } catch { return null; }
    if (!UUID.test(user.id || '') || user.is_anonymous || !Number.isFinite(exp)) return null;
    return { id: user.id, expiresAt: exp * 1000 };
  };
}
async function body(req, limit = 16000) {
  let size = 0; const chunks = [];
  for await (const chunk of req) {
    size += chunk.length; if (size > limit) throw Error('Request too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}
function createGateway(config, { verifyUser = makeVerifier(config), now = Date.now } = {}) {
  const tickets = new Map(), sessions = new Map(), attempts = new Map();
  const host = new URL(config.publicOrigin).host;
  const workerOrigin = 'http://127.0.0.1:' + config.workerPort;
  const token = () => crypto.randomBytes(32).toString('base64url');
  function prune() {
    for (const map of [tickets, sessions, attempts]) for (const [k, v] of map) if (v.expiresAt <= now()) map.delete(k);
  }
  function currentSession(req) {
    const cookies = String(req.headers.cookie || '').split(';').map(v => v.trim()).filter(v => v.startsWith(COOKIE + '='));
    if (cookies.length !== 1) return null;
    const s = sessions.get(cookies[0].slice(COOKIE.length + 1));
    return s && s.expiresAt > now() && config.allowedUserIds.has(s.id) ? s : null;
  }
  function baseHeaders(res) {
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "frame-ancestors 'self' " + config.nexusOrigin);
  }
  function reply(res, status, value) {
    res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value));
  }
  function cors(req, res) {
    if (req.headers.origin !== config.nexusOrigin) return false;
    res.setHeader('Access-Control-Allow-Origin', config.nexusOrigin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    return true;
  }
  function proxy(req, res) {
    // No Nexus JWT, gateway session cookie or forwarding identity reaches the agent process.
    const headers = { ...req.headers, host: '127.0.0.1:' + config.workerPort };
    for (const k of Object.keys(headers)) if (/^(cookie|authorization|forwarded|x-forwarded-.*|proxy-.*|connection|upgrade)$/i.test(k)) delete headers[k];
    if (headers.origin) headers.origin = workerOrigin;
    delete headers.referer;
    const upstream = http.request({ hostname: '127.0.0.1', port: config.workerPort,
      method: req.method, path: req.url, headers }, response => {
      for (const [k, v] of Object.entries(response.headers)) {
        if (v != null && !/^(set-cookie|connection|transfer-encoding|content-security-policy|cache-control|access-control-.*|x-frame-options)$/i.test(k)) {
          if (k === 'location') {
            const target = new URL(String(v), workerOrigin);
            // Never redirect a member to a loopback worker or an arbitrary origin.
            if (target.origin !== workerOrigin) { response.resume(); return reply(res, 502, { error: 'Unsupported station redirect' }); }
            res.setHeader(k, config.publicOrigin + target.pathname + target.search + target.hash);
          } else res.setHeader(k, v);
        }
      }
      baseHeaders(res);
      res.writeHead(response.statusCode || 502); response.pipe(res);
      response.on('error', () => res.destroy());
    });
    upstream.setTimeout(120000, () => upstream.destroy());
    upstream.on('error', () => { if (!res.headersSent) reply(res, 502, { error: 'Station unavailable' }); else res.destroy(); });
    req.on('aborted', () => upstream.destroy());
    res.on('close', () => { if (!res.writableEnded) upstream.destroy(); });
    req.pipe(upstream);
  }
  const server = http.createServer(async (req, res) => {
    baseHeaders(res); prune();
    try {
      if (req.headers.host !== host) return reply(res, 403, { error: 'Invalid host' });
      if (!req.url.startsWith('/') || req.url.startsWith('//')) return reply(res, 400, { error: 'Invalid path' });
      const url = new URL(req.url, config.publicOrigin);
      if (url.pathname === '/__council/health' && req.method === 'GET') return reply(res, 200, { status: 'gateway-ready' });
      if (url.pathname === '/__council/launch') {
        if (!cors(req, res)) return reply(res, 403, { error: 'Invalid origin' });
        if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
        if (req.method !== 'POST') return reply(res, 405, { error: 'POST required' });
        const ip = req.socket.remoteAddress || 'unknown';
        const count = attempts.get(ip) || { count: 0, expiresAt: now() + 60000 };
        count.count++; attempts.set(ip, count);
        if (count.count > 30 || tickets.size >= 256 || sessions.size >= 256) return reply(res, 429, { error: 'Try again shortly' });
        const bearer = String(req.headers.authorization || '').match(/^Bearer (\S+)$/)?.[1];
        const user = bearer ? await verifyUser(bearer) : null;
        if (!user || user.expiresAt <= now()) return reply(res, 401, { error: 'Sign in to Nexus again' });
        if (!config.allowedUserIds.has(user.id)) return reply(res, 403, { error: 'This station is not assigned to you' });
        const ticket = token();
        tickets.set(ticket, { id: user.id, expiresAt: Math.min(user.expiresAt, now() + 30000), authExpiresAt: user.expiresAt });
        return reply(res, 200, { ticket, action: config.publicOrigin + '/__council/session' });
      }
      if (url.pathname === '/__council/session') {
        if (req.method !== 'POST' || req.headers.origin !== config.nexusOrigin) return reply(res, 403, { error: 'Invalid handoff' });
        if (!String(req.headers['content-type'] || '').startsWith('application/x-www-form-urlencoded')) return reply(res, 415, { error: 'Form required' });
        const ticket = new URLSearchParams(await body(req)).get('ticket');
        const claim = tickets.get(ticket); tickets.delete(ticket);
        if (!claim || claim.expiresAt <= now() || !config.allowedUserIds.has(claim.id)) return reply(res, 401, { error: 'Launch expired. Reopen from Nexus.' });
        const session = token(), expiresAt = Math.min(claim.authExpiresAt, now() + 15 * 60000);
        sessions.set(session, { id: claim.id, expiresAt });
        res.setHeader('Set-Cookie', `${COOKIE}=${session}; Path=/; Secure; HttpOnly; SameSite=None; Max-Age=${Math.floor((expiresAt - now()) / 1000)}`);
        res.writeHead(303, { Location: '/' }); return res.end();
      }
      if (url.pathname === '/__council/logout') {
        if (req.method !== 'POST' || ![config.nexusOrigin, config.publicOrigin].includes(req.headers.origin)) return reply(res, 403, { error: 'Invalid logout' });
        const raw = String(req.headers.cookie || '').split(';').map(v => v.trim()).find(v => v.startsWith(COOKIE + '='));
        if (raw) sessions.delete(raw.slice(COOKIE.length + 1));
        res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; Secure; HttpOnly; SameSite=None; Max-Age=0`);
        return reply(res, 200, { signedOut: true });
      }
      if (url.pathname.startsWith('/__council/')) return reply(res, 404, { error: 'Not found' });
      if (!currentSession(req)) return reply(res, 401, { error: 'Open this station from Nexus to sign in.' });
      if (req.headers.origin && req.headers.origin !== config.publicOrigin) return reply(res, 403, { error: 'Invalid origin' });
      if (!['GET', 'HEAD'].includes(req.method) && req.headers.origin !== config.publicOrigin) return reply(res, 403, { error: 'Origin required' });
      proxy(req, res);
    } catch { if (!res.headersSent) reply(res, 503, { error: 'Station sign-in unavailable' }); else res.destroy(); }
  });
  // HTTP/SSE streaming is supported. Do not silently expose native terminal sockets.
  server.on('upgrade', (_req, socket) => socket.end('HTTP/1.1 501 Not Implemented\r\nConnection: close\r\n\r\n'));
  server.headersTimeout = 15000;
  server.requestTimeout = 120000;
  return server;
}
if (require.main === module) {
  const config = configuration();
  createGateway(config).listen(config.port, '127.0.0.1', () => console.log('Council gateway listening on loopback port ' + config.port));
}
module.exports = { configuration, createGateway, makeVerifier };
