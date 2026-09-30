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
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const host = "127.0.0.1";
const gatewayPort = Number(process.env.EF_COUNCIL_GATEWAY_PORT || 8799);
const firstMemberPort = Number(process.env.EF_COUNCIL_MEMBER_PORT_START || 8801);
const secret = String(process.env.EF_COUNCIL_LAUNCH_SECRET || "").trim();
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

if (secret.length < 32) {
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
  const [payload, signature] = String(token || "").split(".");
  if (!payload || !signature) throw new Error("missing launch ticket");
  const expected = sign(payload);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new Error("invalid launch ticket");
  const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(data.sub || ""))) throw new Error("invalid member");
  const issued = Number(data.iat || 0);
  if (!issued || Math.abs(Date.now() - issued) > maxTicketAgeMs) throw new Error("expired launch ticket");
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
  const existing = stations.get(namespace);
  if (!existing && defaultStationPort && member === defaultMember && await portReady(defaultStationPort)) {
    const adopted = { port: defaultStationPort, child: null, namespace, workspaceRoot: null, adopted: true };
    stations.set(namespace, adopted);
    return adopted;
  }
  if (existing && await portReady(existing.port)) return existing;
  if (existing) stations.delete(namespace);

  const port = nextPort++;
  const workspaceRoot = path.join(root, ".ef-nexus-workspaces", namespace);
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
    EF_NEXUS_MEMBER_NAMESPACE: namespace,
  };
  const child = spawn(process.execPath, [path.join(root, "sidecar", "index.js")], { cwd: root, env, stdio: "inherit", windowsHide: true });
  const station = { port, child, namespace, workspaceRoot };
  stations.set(namespace, station);
  child.once("exit", () => { if (stations.get(namespace)?.child === child) stations.delete(namespace); });

  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    if (await portReady(port)) return station;
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
  let id = cookieValue(req, sessionCookie) || url.searchParams.get(sessionQuery) || "";
  if (!id && req.headers.referer) {
    try {
      const referer = new URL(String(req.headers.referer));
      if (referer.hostname === "council.efventures.app") id = referer.searchParams.get(sessionQuery) || "";
    } catch {}
  }
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
function proxyHttp(req, res, station) {
  const headers = { ...req.headers, host: `${host}:${station.port}` };
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
    // Preserve the gateway cookie established on the first authenticated page.\n    // Without this, the HTML loads via ef_session but subsequent CSS/JS/image requests lose the session.\n    const gatewayCookie = res.getHeader("set-cookie");\n    if (gatewayCookie) {\n      const upstreamCookies = responseHeaders["set-cookie"];\n      responseHeaders["set-cookie"] = [\n        ...(Array.isArray(upstreamCookies) ? upstreamCookies : upstreamCookies ? [upstreamCookies] : []),\n        ...(Array.isArray(gatewayCookie) ? gatewayCookie : [String(gatewayCookie)]),\n      ];\n    }\n    const contentType = String(upstreamRes.headers["content-type"] || "").toLowerCase();
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
  req.pipe(upstream);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${host}:${gatewayPort}`);
    if (url.pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (url.pathname === "/launch") {
      const ticket = verifyTicket(url.searchParams.get("ticket"));
      const station = await stationFor(String(ticket.sub));
      const id = crypto.randomBytes(32).toString("base64url");
      const member = String(ticket.sub);
      sessions.set(id, { station, createdAt: Date.now(), member });
      memberSessions.set(member, id);
      const target = new URL("/", "https://council.efventures.app");
      target.searchParams.set(sessionQuery, id);
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
    const session = sessionFor(req);
    if (!session) {
      res.writeHead(401, { "content-type": "text/plain", "cache-control": "no-store" });
      res.end("EF Agent Council session required.");
      return;
    }
    ensureSessionCookie(req, res, session);
    proxyHttp(req, res, session.station);
  } catch (error) {
    res.writeHead(401, { "content-type": "text/plain", "cache-control": "no-store" });
    res.end("EF Agent Council launch denied: " + (error instanceof Error ? error.message : "unknown error"));
  }
});

server.on("upgrade", (req, socket, head) => {
  const session = sessionFor(req);
  if (!session) {
    socket.write("HTTP/1.1 401 Unauthorized\\r\\nConnection: close\\r\\n\\r\\n");
    socket.destroy();
    return;
  }
  const upstream = http.request({
    host,
    port: session.station.port,
    timeout: 0,
    method: req.method,
    path: proxyPath(req),
    headers: { ...req.headers, host: `${host}:${session.station.port}` },
  });
  upstream.setTimeout(0);
  upstream.on("upgrade", (upstreamRes, upstreamSocket, upstreamHead) => {
    socket.setTimeout(0);
    upstreamSocket.setTimeout(0);
    let response = `HTTP/1.1 ${upstreamRes.statusCode || 101} ${upstreamRes.statusMessage || "Switching Protocols"}\\r\\n`;
    for (const [key, value] of Object.entries(upstreamRes.headers)) {
      if (Array.isArray(value)) for (const item of value) response += `${key}: ${item}\\r\\n`;
      else if (value !== undefined) response += `${key}: ${value}\\r\\n`;
    }
    socket.write(response + "\\r\\n");
    if (upstreamHead.length) socket.write(upstreamHead);
    if (head.length) upstreamSocket.write(head);
    upstreamSocket.pipe(socket).pipe(upstreamSocket);
  });
  upstream.on("error", () => socket.destroy());
  upstream.end();
});
server.listen(gatewayPort, host, () => {
  console.log(`EF Agent Council Nexus gateway listening on http://${host}:${gatewayPort}`);
});
