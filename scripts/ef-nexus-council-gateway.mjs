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
const gatewayPort = Number(process.env.EF_COUNCIL_GATEWAY_PORT || 8798);
const firstMemberPort = Number(process.env.EF_COUNCIL_MEMBER_PORT_START || 8801);
const secret = String(process.env.EF_COUNCIL_LAUNCH_SECRET || "").trim();\nconst defaultStationPort = Number(process.env.EF_COUNCIL_EXISTING_STATION_PORT || 0);\nconst defaultMember = String(process.env.EF_COUNCIL_EXISTING_STATION_MEMBER || "").trim();
const maxTicketAgeMs = 2 * 60 * 1000;
const stations = new Map();
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
  const existing = stations.get(namespace);\n  if (!existing && defaultStationPort && member === defaultMember && await portReady(defaultStationPort)) {\n    const adopted = { port: defaultStationPort, child: null, namespace, workspaceRoot: null, adopted: true };\n    stations.set(namespace, adopted);\n    return adopted;\n  }
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

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${host}:${gatewayPort}`);
    if (url.pathname === "/health") {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ ok: true, activeMemberStations: stations.size }));
      return;
    }
    if (url.pathname !== "/launch") {
      res.writeHead(404, { "content-type": "text/plain" }); res.end("Not found"); return;
    }
    const ticket = verifyTicket(url.searchParams.get("ticket"));
    const station = await stationFor(String(ticket.sub));
    const target = new URL(`http://${host}:${station.port}/`);
    if (ticket.agent) target.searchParams.set("agent", String(ticket.agent));
    res.writeHead(302, { location: target.toString(), "cache-control": "no-store", "referrer-policy": "no-referrer" });
    res.end();
  } catch (error) {
    res.writeHead(401, { "content-type": "text/plain", "cache-control": "no-store" });
    res.end("EF Agent Council launch denied: " + (error instanceof Error ? error.message : "unknown error"));
  }
});
server.listen(gatewayPort, host, () => {
  console.log(`EF Agent Council Nexus gateway listening on http://${host}:${gatewayPort}`);
});
