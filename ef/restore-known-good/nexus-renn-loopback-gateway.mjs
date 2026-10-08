#!/usr/bin/env node
import http from "node:http";

const host = "127.0.0.1";
const port = Number(process.env.NEXUS_RENN_GATEWAY_PORT || process.env.PORT || 4000);
const modelRoute = process.env.NEXUSRENN_MODEL_ROUTE || "nexus-primary";
const localModel = process.env.EF_COUNCIL_LOCAL_MODEL || process.env.STARNET_DEFAULT_MODEL || "qwen3:8b";
const localBase = (process.env.EF_COUNCIL_LOCAL_BASE_URL || process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434/v1").replace(/\/+$/, "");
const ollamaOrigin = localBase.replace(/\/v1$/, "");

function send(res, status, body) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

function promptFrom(messages = []) {
  return messages.map(m => `${m.role || "user"}: ${m.content || ""}`).join("\n").trim();
}

async function complete(body) {
  const prompt = promptFrom(body.messages) || String(body.prompt || "");
  const response = await fetch(`${ollamaOrigin}/api/generate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: localModel,
      prompt,
      stream: false,
      think: false,
      options: { num_predict: Number(body.max_tokens || 512), temperature: Number(body.temperature || 0.2) },
    }),
  });
  if (!response.ok) throw new Error(`Ollama ${response.status}`);
  const data = await response.json();
  const content = String(data.response || "").trim();
  return {
    id: `nexus-renn-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: modelRoute,
    choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
  };
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${host}:${port}`);
    if (req.method === "GET" && (url.pathname === "/health" || url.pathname === "/v1/models")) {
      return send(res, 200, { ok: true, object: "list", data: [{ id: modelRoute, object: "model", owned_by: "local-ollama" }], localModel, ollamaOrigin });
    }
    if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
      return send(res, 200, await complete(await readJson(req)));
    }
    return send(res, 404, { error: "not found" });
  } catch (error) {
    return send(res, 502, { error: error instanceof Error ? error.message : "gateway failed" });
  }
});

server.listen(port, host, () => {
  console.log(`Nexus ReNN loopback gateway listening on http://${host}:${port} using ${localModel}`);
});
