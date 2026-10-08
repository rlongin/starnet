#!/usr/bin/env node
/**
 * EF Ventures Nexus Council gateway.
 *
 * One loopback gateway accepts a signed Nexus launch ticket, derives an opaque
 * per-member namespace, starts that member's existing StarNet runtime on a
 * dedicated loopback port, and redirects the browser to it.
 *
 * Security:
 * - binds only to 127.0.0.1
 * - launch tickets are HMAC-SHA256 signed and expire quickly
 * - member UUID never becomes a filesystem folder name
 * - child runtimes receive isolated SKYNET/STARNET_WORKSPACES roots
 */
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileAsync = promisify(execFile);
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const stationRoot = path.resolve(process.env.EF_COUNCIL_STATION_ROOT || root);
const workspaceBase = path.resolve(process.env.EF_COUNCIL_DATA_ROOT || path.join(root, ".ef-nexus-workspaces"));
const stationEntry = path.join(stationRoot, "sidecar", "index.js");
const localModel = String(process.env.EF_COUNCIL_LOCAL_MODEL || '').trim();
const localBaseUrl = String(process.env.EF_COUNCIL_LOCAL_BASE_URL || 'http://127.0.0.1:11434/v1');
if (localModel) {
  const u = new URL(localBaseUrl);
  if (u.protocol !== 'http:' || u.hostname !== '127.0.0.1' || u.username || u.password || u.search || u.hash) throw Error('Council local model endpoint must be loopback');
}
const release = "council-repair-v3";
const pendingStations = new Map();
const usedTickets = new Map();
const registryFile = path.join(here, "council-stations.json");
function readRegistry() {
  if (!fs.existsSync(registryFile)) return {};
  const envelope = JSON.parse(fs.readFileSync(registryFile, "utf8"));
  const payload = JSON.stringify(envelope.stations);
  const expected = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  if (typeof envelope.signature !== "string" || envelope.signature.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(envelope.signature), Buffer.from(expected))) {
    throw new Error("Council station registry cannot be verified; keep the existing key and restore its backup");
  }
  return envelope.stations;
}
function writeRegistry(records) {
  const payload = JSON.stringify(records);
  const envelope = { stations: records, signature: crypto.createHmac("sha256", secret).update(payload).digest("hex") };
  const temp = registryFile + ".tmp-" + process.pid;
  const fd = fs.openSync(temp, "w", 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(envelope)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  if (fs.existsSync(registryFile)) fs.copyFileSync(registryFile, registryFile + ".bak");
  fs.renameSync(temp, registryFile);
}
async function recordOwnerAlive(record) {
  if (!Number.isInteger(record.pid) || record.pid <= 0 || record.entry !== stationEntry ||
      !Number.isInteger(record.port) || record.port < firstMemberPort || record.port > 65535) return false;
  try {
    if (process.platform === "win32") {
      const quote = text => "'" + String(text).replaceAll("'", "''") + "'";
      const script = `$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${record.pid}'; $port=Get-NetTCPConnection -State Listen -LocalPort ${record.port} -ErrorAction SilentlyContinue; if ($p -and $p.ExecutablePath -ieq ${quote(process.execPath)} -and $p.CommandLine.Contains(${quote(stationEntry)}) -and ($port.OwningProcess -contains ${record.pid})) { 'owner-confirmed' }`;
      const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script,"utf16le").toString("base64")], { timeout: 8000, windowsHide: true });
      return stdout.trim() === "owner-confirmed";
    }
    return fs.readFileSync(`/proc/${record.pid}/cmdline`, "utf8").split("\0").includes(stationEntry);
  } catch { return false; }
}
const host = "127.0.0.1";
const gatewayPort = Number(process.env.EF_COUNCIL_GATEWAY_PORT || 8799);
const firstMemberPort = Number(process.env.EF_COUNCIL_MEMBER_PORT_START || 8801);
const secret = String(process.env.EF_COUNCIL_LAUNCH_SECRET || "").trim();
const recoverySecret = String(process.env.EF_AI_RECOVERY_SECRET || "").trim();
const defaultStationPort = Number(process.env.EF_COUNCIL_EXISTING_STATION_PORT || 0);
const defaultMember = String(process.env.EF_COUNCIL_EXISTING_STATION_MEMBER || "").trim();
const maxTicketAgeMs = 2 * 60 * 1000;
const stations = new Map();
const sessions = new Map();
const memberSessions = new Map();
const sessionCookie = "ef_council_session";
const sessionQuery = "ef_session";
const sessionMaxAgeMs = 12 * 60 * 60 * 1000;
let nextPort = firstMemberPort;

if (secret.length < 32 && recoverySecret.length < 24) {
  console.error("EF_COUNCIL_LAUNCH_SECRET must be at least 32 characters.");
  process.exit(2);
}

function b64url(value) {
  return Buffer.from(value).toString("base64url");
}
function sign(payload) {
  return crypto.createHmac("sha256", secret).update(payload).digest("base64url");
}
function verifyTicket(token) {
  if (secret.length < 32) throw new Error("Council launch key is not configured; recovery endpoints remain available.");
  const text = String(token || "");
  if (text.length > 4096 || text.split(".").length !== 2) throw new Error("invalid launch ticket");
  const [payload, signature] = text.split(".");
  if (!payload || !signature) throw new Error("missing launch ticket");
  const expected = sign(payload);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new Error("invalid launch ticket");
  const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(data.sub || ""))) throw new Error("invalid member");
  const issued = Number(data.iat || 0);
  if (!issued || (Date.now() - issued > maxTicketAgeMs || issued > Date.now() + 30000)) throw new Error("expired launch ticket");
  for (const [key, expires] of usedTickets) if (expires <= Date.now()) usedTickets.delete(key);
  const ticketId = crypto.createHash("sha256").update(text).digest("hex");
  if (usedTickets.has(ticketId)) throw new Error("launch ticket already used");
  if (usedTickets.size >= 4096) throw new Error("too many launches; try again shortly");
  usedTickets.set(ticketId, issued + maxTicketAgeMs);
  return data;
}
function namespaceFor(member) {
  return crypto.createHash("sha256").update("efv:nexus:" + member).digest("hex").slice(0, 32);
}
async function portReady(port) {
  return await new Promise(resolve => {
    const req = http.get({ host, port, path: "/", timeout: 700 }, res => { res.resume(); resolve(true); });
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
  });
}
async function stationFor(member) {
  const namespace = namespaceFor(member);
  if (pendingStations.has(namespace)) return pendingStations.get(namespace);
  const pending = createStation(member);
  pendingStations.set(namespace, pending);
  try { return await pending; } finally { pendingStations.delete(namespace); }
}
async function createStation(member) {
  const namespace = namespaceFor(member);
  const existing = stations.get(namespace);
  const records = readRegistry();
  const saved = records[namespace];
  if (!existing && saved && saved.workspaceRoot === path.join(workspaceBase, namespace) &&
      await recordOwnerAlive(saved) && await portReady(saved.port)) {
    if (saved.member !== member) { saved.member = member; writeRegistry(records); }
    const adopted = { ...saved, namespace, child: null, adopted: true };
    stations.set(namespace, adopted); return adopted;
  }
  if (!existing && saved) {
    try { process.kill(saved.pid, 0); throw new Error("An existing member station needs inspection before starting another instance"); }
    catch (error) { if (error.code !== "ESRCH") throw error; }
    delete records[namespace]; writeRegistry(records);
  }
  if (!existing && defaultStationPort && member === defaultMember && await portReady(defaultStationPort)) {
    const adopted = { port: defaultStationPort, child: null, namespace, workspaceRoot: null, adopted: true };
    stations.set(namespace, adopted);
    return adopted;
  }
  if (existing && await portReady(existing.port)) return existing;
  if (existing) {
    const pid = existing.child?.pid || existing.pid || saved?.pid;
    if (pid) {
      try { process.kill(pid, 0); }
      catch (error) {
        if (error.code === 'ESRCH') { stations.delete(namespace); return createStation(member); }
        throw error;
      }
    }
    throw new Error("Existing Council runtime is not responding; refusing a duplicate process");
  }

  if (!fs.existsSync(stationEntry)) throw new Error("StarNet station entry is missing; check EF_COUNCIL_STATION_ROOT");
  let port = saved && Number.isInteger(saved.port) ? saved.port : nextPort++;
  while (await portReady(port)) {
    port = nextPort++;
    if (port >= firstMemberPort + 128 || port > 65535) throw new Error("Council station port range exhausted");
  }
  const workspaceRoot = path.join(workspaceBase, namespace);
  fs.mkdirSync(workspaceRoot, { recursive: true });
  const env = {
    ...process.env,
    SKYNET_WORKSPACES: workspaceRoot,
    STARNET_WORKSPACES: workspaceRoot,
    SKYNET_PORT: String(port),
    STARNET_PORT: String(port),
    // Serve the complete StarNet frontend for Nexus member stations. In EF_STUDIO mode
    // the sidecar intentionally restricts static files to /ef/*, which strips the normal
    // css/, app/ and assets/ resources and leaves the browser with raw HTML.
    EF_ORIGINAL_UI: "1",
    STARNET_EF_ORIGINAL_UI: "1",
    NODE_PATH: path.join(stationRoot, 'ef', 'node_modules'),
    ...(localModel ? { OLLAMA_BASE_URL: localBaseUrl, STARNET_DEFAULT_MODEL: localModel } : {}),
    EF_NEXUS_MEMBER_NAMESPACE: namespace,
  };
  delete env.EF_COUNCIL_LAUNCH_SECRET;
  delete env.EF_AI_RECOVERY_SECRET;
  // A station must survive an abrupt gateway exit. Inheriting gateway pipes or
  // its Windows console couples the station lifetime to the failed gateway.
  // Append directly to a member log rather than piping output through the parent.
  const logRoot = path.join(workspaceBase, "_runtime-logs"); fs.mkdirSync(logRoot, { recursive: true }); const logFd = fs.openSync(path.join(logRoot, namespace + ".log"), "a", 0o600);
  let child;
  try {
    child = spawn(process.execPath, [stationEntry], {
      cwd: stationRoot, env, detached: true,
      stdio: ["ignore", logFd, logFd], windowsHide: true,
    });
  } finally { fs.closeSync(logFd); }
  child.unref();
  let childError = null;
  child.once("error", error => { childError = error; });
  const station = { port, child, namespace, workspaceRoot, member };
  stations.set(namespace, station);
  child.once("exit", () => { if (stations.get(namespace)?.child === child) stations.delete(namespace); });

  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    if (childError || child.exitCode !== null) break;
    if (await portReady(port)) {
      const records = readRegistry();
      records[namespace] = { pid: child.pid, port, workspaceRoot, entry: stationEntry, member };
      try { writeRegistry(records); } catch (error) { child.kill(); stations.delete(namespace); throw error; }
      return station;
    }
    await new Promise(r => setTimeout(r, 250));
  }
  try { child.kill(); } catch {}
  stations.delete(namespace);
  throw new Error("member Council runtime did not become ready");
}

function cookieValue(req, name) {
  const raw = String(req.headers.cookie || "");
  for (const part of raw.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return "";
}
function sessionFor(req) {
  const url = new URL(req.url || "/", `http://${host}:${gatewayPort}`);
  const id = cookieValue(req, sessionCookie);
  const session = sessions.get(id);
  if (!session) return null;
  if (Date.now() - session.createdAt > sessionMaxAgeMs) {
    sessions.delete(id);
    return null;
  }
  return session;
}
function proxyPath(req) {
  const url = new URL(req.url || "/", `http://${host}:${gatewayPort}`);
  url.searchParams.delete(sessionQuery);
  return url.pathname + (url.searchParams.size ? `?${url.searchParams.toString()}` : "");
}
function ensureSessionCookie(req, res, session) {
  if (cookieValue(req, sessionCookie)) return;
  for (const [id, candidate] of sessions) {
    if (candidate === session) {
      res.setHeader("set-cookie", `${sessionCookie}=${id}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=43200`);
      return;
    }
  }
}
async function proxyHttp(req, res, station) {
  let localBody = null;
  const route = new URL(req.url, 'http://localhost').pathname;
  if (localModel && req.method === 'POST' && ['/api/run','/api/roster','/api/providers/probe','/api/providers/validate'].includes(route)) {
    const parts = []; let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 2 * 1024 * 1024) { res.writeHead(413); res.end('Council request too large'); return; }
      parts.push(chunk);
    }
    let body;
    try { body = JSON.parse(Buffer.concat(parts).toString('utf8')); }
    catch { res.writeHead(400); res.end('Invalid Council JSON'); return; }
    if (!body || typeof body !== 'object' || Array.isArray(body)) { res.writeHead(400); res.end('Council object required'); return; }
    const local = value => {
      value.provider = 'ollama'; value.model = localModel; value.baseUrl = localBaseUrl;
      value.reasoningEffort = 'none';
      delete value.key; delete value.apiKey; delete value.api_key; delete value.keyPool;
      delete value.base_url; delete value.fallbackProviders; delete value.fallbackModels;
      return value;
    };
    if (route === '/api/roster') {
      if (Array.isArray(body.agents)) body.agents = body.agents.map(a => local({...a}));
    } else local(body);
    localBody = Buffer.from(JSON.stringify(body));
  }
  const headers = { ...req.headers, host: `${host}:${station.port}` };
  if (localBody) { headers['content-length'] = String(localBody.length); delete headers['transfer-encoding']; }
  delete headers.cookie;
  delete headers.authorization;
  delete headers.referer;
  if (headers.origin === "https://council.efventures.app") headers.origin = `http://${host}:${station.port}`;
  delete headers["cf-connecting-ip"];
  delete headers["cf-ipcountry"];
  delete headers["cf-ray"];
  delete headers["cf-visitor"];
  const upstream = http.request({
    host,
    port: station.port,
    timeout: 0,
    method: req.method,
    path: proxyPath(req),
    headers,
  }, upstreamRes => {
    const responseHeaders = { ...upstreamRes.headers };
    delete responseHeaders["content-security-policy"];
    delete responseHeaders["content-security-policy-report-only"];
    delete responseHeaders["x-frame-options"];
    delete responseHeaders["cross-origin-opener-policy"];
    delete responseHeaders["cross-origin-embedder-policy"];
    // Preserve the gateway cookie established on the first authenticated page.
    // Without this, the HTML loads via ef_session but subsequent CSS/JS/image requests lose the session.
    const gatewayCookie = res.getHeader("set-cookie");
    if (gatewayCookie) {
      const upstreamCookies = responseHeaders["set-cookie"];
      responseHeaders["set-cookie"] = [
        ...(Array.isArray(upstreamCookies) ? upstreamCookies : upstreamCookies ? [upstreamCookies] : []),
        ...(Array.isArray(gatewayCookie) ? gatewayCookie : [String(gatewayCookie)]),
      ];
    }
    const contentType = String(upstreamRes.headers["content-type"] || "").toLowerCase();
    const isSse = contentType.includes("text/event-stream");
    if (isSse) {
      // Cloudflare -> gateway -> StarNet must remain a true SSE stream. Do not forward
      // hop-by-hop framing from the loopback response; let this server create its own
      // chunked stream and flush headers immediately so EventSource reaches OPEN.
      delete responseHeaders["connection"];
      delete responseHeaders["transfer-encoding"];
      delete responseHeaders["content-length"];
      responseHeaders["content-type"] = upstreamRes.headers["content-type"] || "text/event-stream; charset=utf-8";
      responseHeaders["cache-control"] = "no-cache, no-store, no-transform";
      responseHeaders["x-accel-buffering"] = "no";
      res.writeHead(upstreamRes.statusCode || 200, responseHeaders);
      res.flushHeaders?.();
      req.socket?.setTimeout?.(0);
      req.socket?.setKeepAlive?.(true, 15000);
      upstreamRes.socket?.setTimeout?.(0);
      upstreamRes.socket?.setKeepAlive?.(true, 15000);
      upstreamRes.on("data", chunk => { if (!res.destroyed) res.write(chunk); });
      upstreamRes.on("end", () => { if (!res.destroyed) res.end(); });
      upstreamRes.on("error", () => { if (!res.destroyed) res.end(); });
      return;
    }
    res.writeHead(upstreamRes.statusCode || 502, responseHeaders);
    // Agent replies are long-lived streamed responses. Keep the proxy connection open
    // until StarNet itself ends the stream; never let the gateway impose a response timeout.
    req.socket?.setTimeout?.(0);
    upstreamRes.pipe(res);
  });
  upstream.setTimeout(0);
  upstream.on("error", error => {
    if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain", "cache-control": "no-store" });
    res.end("Council runtime unavailable: " + error.message);
  });
  if (localBody) upstream.end(localBody); else req.pipe(upstream);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${host}:${gatewayPort}`);
    if (url.pathname === "/ef-ai/status" || url.pathname === "/ef-ai/repair") {
      if (recoverySecret.length < 24 || req.headers.authorization !== `Bearer ${recoverySecret}`) {
        res.writeHead(403, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ ok: false, error: "forbidden" }));
        return;
      }
      if (req.method !== "POST") {
        res.writeHead(405, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ ok: false, error: "method not allowed" }));
        return;
      }
      const apply = url.pathname === "/ef-ai/repair";
      const script = path.join(root, "scripts", "ef-ai-recovery.ps1");
      try {
        const args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, ...(apply ? ["-Apply"] : [])];
        const { stdout } = await execFileAsync("powershell.exe", args, { cwd: root, windowsHide: true, timeout: 300000, maxBuffer: 1024 * 1024 });
        const report = JSON.parse(stdout.trim());
        res.writeHead(report.overall ? 200 : 503, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify(report));
      } catch (error) {
        res.writeHead(500, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : "recovery failed" }));
      }
      return;
    }
    if (url.pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ ok: true, release, launchConfigured: secret.length >= 32,
        stationConfigured: fs.existsSync(stationEntry), localModel: localModel || null, localModelConfigured: !!localModel, activeStations: stations.size }));
      return;
    }
    if (url.pathname === "/launch") {
      const ticket = verifyTicket(url.searchParams.get("ticket"));
      const station = await stationFor(String(ticket.sub));
      const id = crypto.randomBytes(32).toString("base64url");
      const member = String(ticket.sub);
      sessions.set(id, { station, createdAt: Date.now(), member });
      const target = new URL("/", "https://council.efventures.app");
      const previous = memberSessions.get(member);
      if (previous) sessions.delete(previous);
      memberSessions.set(member, id);
      if (ticket.agent) target.searchParams.set("agent", String(ticket.agent));
      res.writeHead(302, {
        location: target.pathname + target.search,
        "set-cookie": `${sessionCookie}=${id}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=43200`,
        "cache-control": "no-store",
        "referrer-policy": "no-referrer",
      });
      res.end();
      return;
    }
    if (req.headers.origin && req.headers.origin !== "https://council.efventures.app") {
      res.writeHead(403, { "content-type": "text/plain", "cache-control": "no-store" });
      res.end("Invalid Council origin."); return;
    }
    const session = sessionFor(req);
    if (!session) {
      res.writeHead(401, { "content-type": "text/plain", "cache-control": "no-store" });
      res.end("EF Agent Council session required.");
      return;
    }
    ensureSessionCookie(req, res, session);
    session.station = await stationFor(session.member);
    await proxyHttp(req, res, session.station);
  } catch (error) {
    res.writeHead(401, { "content-type": "text/plain", "cache-control": "no-store" });
    res.end("EF Agent Council launch denied: " + (error instanceof Error ? error.message : "unknown error"));
  }
});

server.on("upgrade", (req, socket, head) => {
  const session = sessionFor(req);
  if (!session || req.headers.origin !== "https://council.efventures.app") {
    socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  const upstream = http.request({
    host,
    port: session.station.port,
    timeout: 0,
    method: req.method,
    path: proxyPath(req),
    headers: (() => {
      const headers = { ...req.headers, host: `${host}:${session.station.port}`, origin: `http://${host}:${session.station.port}` };
      delete headers.cookie; delete headers.authorization; delete headers.referer;
      return headers;
    })(),
  });
  upstream.setTimeout(0);
  upstream.on("upgrade", (upstreamRes, upstreamSocket, upstreamHead) => {
    socket.setTimeout(0);
    upstreamSocket.setTimeout(0);
    let response = `HTTP/1.1 ${upstreamRes.statusCode || 101} ${upstreamRes.statusMessage || "Switching Protocols"}\r\n`;
    for (const [key, value] of Object.entries(upstreamRes.headers)) {
      if (Array.isArray(value)) for (const item of value) response += `${key}: ${item}\r\n`;
      else if (value !== undefined) response += `${key}: ${value}\r\n`;
    }
    socket.write(response + "\r\n");
    if (upstreamHead.length) socket.write(upstreamHead);
    if (head.length) upstreamSocket.write(head);
    upstreamSocket.pipe(socket).pipe(upstreamSocket);
  });
  upstream.on("response", response => { response.resume(); socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n"); });
  upstream.on("error", () => socket.destroy());
  upstream.end();
});
for (const port of [gatewayPort, firstMemberPort]) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Invalid Council port configuration");
}
server.on("error", error => { console.error("Council gateway could not start: " + error.code); process.exitCode = 1; });
server.listen(gatewayPort, host, () => {
  console.log(`EF Agent Council Nexus gateway listening on http://${host}:${gatewayPort}`);
});
let monitoring = false;
const monitor = setInterval(async () => {
  if (monitoring) return;
  monitoring = true;
  try {
    const restored = Object.values(readRegistry()).filter(r =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(r.member || '') &&
      r.workspaceRoot === path.join(workspaceBase, namespaceFor(r.member)));
    const members = new Set([...sessions.values()].map(s => s.member).concat(restored.map(r => r.member)));
    for (const member of members) {
      try {
        const station = await stationFor(member);
        for (const session of sessions.values()) if (session.member === member) session.station = station;
      } catch (error) { console.error('Council runtime recovery: ' + error.message); }
    }
  } finally { monitoring = false; }
}, 10000);
monitor.unref();
// Restore previously signed member runtime assignments after sign-in startup.
if (secret.length >= 32) {
  try {
    for (const record of Object.values(readRegistry())) {
      if (record.member && namespaceFor(record.member) === path.basename(record.workspaceRoot)) {
        stationFor(record.member).catch(error => console.error('Council startup recovery: ' + error.message));
      }
    }
  } catch (error) { console.error(error.message); }
}
function shutdown() {
  clearInterval(monitor);

  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
