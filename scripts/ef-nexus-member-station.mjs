#!/usr/bin/env node
/**
 * EF Ventures Nexus member-isolated StarNet launcher.
 *
 * Starts the existing StarNet sidecar with a workspace root derived from the
 * authenticated Nexus member UUID. No member identifier is used as a folder
 * name; a SHA-256 digest provides a stable opaque namespace.
 *
 * Usage:
 *   node scripts/ef-nexus-member-station.mjs --member <uuid> [--port 8801]
 *
 * This deliberately does not replace the known-good Council station. Run it on
 * a separate port while validating Nexus member isolation.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const member = String(arg("--member") || process.env.NEXUS_MEMBER_ID || "").trim();
if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(member)) {
  console.error("EF Agent Council: a valid Nexus member UUID is required (--member or NEXUS_MEMBER_ID).");
  process.exit(2);
}

const requestedPort = Number(arg("--port") || process.env.NEXUS_COUNCIL_PORT || 8801);
if (!Number.isInteger(requestedPort) || requestedPort < 1024 || requestedPort > 65535) {
  console.error("EF Agent Council: port must be an integer from 1024 through 65535.");
  process.exit(2);
}

const namespace = crypto.createHash("sha256").update("efv:nexus:" + member).digest("hex").slice(0, 32);
const workspaceRoot = path.join(root, ".ef-nexus-workspaces", namespace);
fs.mkdirSync(workspaceRoot, { recursive: true });

process.env.SKYNET_WORKSPACES = workspaceRoot;
process.env.STARNET_WORKSPACES = workspaceRoot;
process.env.SKYNET_PORT = String(requestedPort);
process.env.STARNET_PORT = String(requestedPort);
process.env.EF_NEXUS_MEMBER_NAMESPACE = namespace;

console.log("EF Agent Council member station");
console.log("  namespace:", namespace);
console.log("  workspace:", workspaceRoot);
console.log("  port:", requestedPort);

await import(path.join(root, "sidecar", "index.js"));
