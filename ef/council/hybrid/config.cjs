'use strict';
const crypto = require('node:crypto');
function secret(value, name) {
  if (!/^[A-Za-z0-9_-]{43,}$/.test(value || '')) throw Error(`${name} must be a random base64url secret (at least 32 bytes)`);
  return value;
}
function integer(value, fallback, min, max) {
  const n = Number(value ?? fallback);
  if (!Number.isInteger(n) || n < min || n > max) throw Error('Invalid numeric configuration');
  return n;
}
function origin(value) {
  const u = new URL(value);
  if (u.protocol !== 'https:' || u.origin !== value || u.username || u.password) throw Error('An exact HTTPS bridge origin is required');
  return value;
}
function routerConfiguration(env = process.env) {
  const stationKey = secret(env.HYBRID_STATION_KEY, 'HYBRID_STATION_KEY');
  const bridgeKey = secret(env.HYBRID_BRIDGE_KEY, 'HYBRID_BRIDGE_KEY');
  if (stationKey === bridgeKey) throw Error('Station and bridge secrets must differ');
  if (env.HYBRID_CLOUD_ENABLED && !['true', 'false'].includes(env.HYBRID_CLOUD_ENABLED)) throw Error('HYBRID_CLOUD_ENABLED must be true or false');
  const cloudEnabled = env.HYBRID_CLOUD_ENABLED === 'true';
  let cloudUrl;
  if (cloudEnabled) {
    const u = new URL(env.HYBRID_CLOUD_BASE_URL);
    if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash) throw Error('Cloud base URL must be HTTPS without credentials or query');
    cloudUrl = u.href.replace(/\/+$/, '') + '/chat/completions';
    if (!env.HYBRID_CLOUD_KEY || !env.HYBRID_CLOUD_MODEL) throw Error('Cloud model and key are required when fallback is enabled');
  }
  return { stationKey, bridgeKey, publicOrigin: origin(env.HYBRID_BRIDGE_ORIGIN),
    port: integer(env.HYBRID_PORT, 8899, 1024, 65535), cloudEnabled, cloudUrl,
    cloudKey: env.HYBRID_CLOUD_KEY, cloudModel: env.HYBRID_CLOUD_MODEL,
    localMs: integer(env.HYBRID_LOCAL_TIMEOUT_MS, 90000, 1000, 300000),
    cloudMs: integer(env.HYBRID_CLOUD_TIMEOUT_MS, 120000, 1000, 300000),
    maxTokens: integer(env.HYBRID_MAX_OUTPUT_TOKENS, 2048, 1, 8192),
    maxInFlight: integer(env.HYBRID_MAX_IN_FLIGHT, 2, 1, 16),
    contextLength: integer(env.HYBRID_CONTEXT_LENGTH, 8192, 2048, 131072),
  };
}
function bridgeConfiguration(env = process.env) {
  const local = new URL(env.HYBRID_OLLAMA_ORIGIN || 'http://127.0.0.1:11434');
  if (local.protocol !== 'http:' || local.hostname !== '127.0.0.1' || local.origin !== local.href.slice(0, -1) || local.username || local.password) throw Error('Ollama must use an exact http://127.0.0.1:PORT origin');
  const model = env.HYBRID_LOCAL_MODEL || 'qwen3:8b';
  if (!/^[a-zA-Z0-9_./:-]{1,160}$/.test(model)) throw Error('Invalid local model');
  return { publicOrigin: origin(env.HYBRID_BRIDGE_ORIGIN), bridgeKey: secret(env.HYBRID_BRIDGE_KEY, 'HYBRID_BRIDGE_KEY'), ollamaOrigin: local.origin, model };
}
function authorized(header, key) {
  const a = Buffer.from(String(header || '')); const b = Buffer.from('Bearer ' + key);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
async function readJSON(stream, limit = 2 * 1024 * 1024) {
  let size = 0; const parts = [];
  for await (const chunk of stream) {
    size += chunk.length; if (size > limit) throw Error('Payload too large');
    parts.push(Buffer.from(chunk));
  }
  return JSON.parse(Buffer.concat(parts).toString('utf8'));
}
module.exports = { routerConfiguration, bridgeConfiguration, authorized, readJSON };
