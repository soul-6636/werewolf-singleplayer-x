import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { buildProviderRequest, extractText, normalizeProviderStreamEvent } from "./server/provider.mjs";
import { appendStoredEvent, readStoredEvents } from "./server/jsonl.mjs";

const root = fileURLToPath(new URL(".", import.meta.url));
const publicDir = join(root, "public");
const eventDir = join(root, "server", "data");
const port = Number(process.env.PORT || 4173);

const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg"
};

function sendJson(res, status, payload) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*"
  });
  res.end(JSON.stringify(payload));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) reject(new Error("请求体过大"));
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

async function proxyModel(req, res) {
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return sendJson(res, 400, { error: "请求 JSON 无法解析" });
  }

  const {
    dialect = "openai",
    baseUrl,
    apiKey,
    model,
    messages = [],
    system = "",
    temperature = 0.7,
    maxTokens = 500,
    endpointPath,
    reasoningEffort
  } = body;

  if (!baseUrl || !model) {
    return sendJson(res, 400, { error: "缺少 baseUrl 或 model" });
  }
  if (!apiKey) return sendJson(res, 400, { error: "请先填写 API Key" });

  const isAnthropic = dialect === "anthropic";
  const providerRequest = buildProviderRequest({
    dialect,
    baseUrl,
    endpointPath,
    apiKey,
    model,
    messages,
    system,
    temperature,
    maxTokens,
    reasoningEffort,
    anthropicVersion: body.anthropicVersion || "2023-06-01"
  });

  try {
    const response = await fetch(providerRequest.url, {
      method: "POST",
      headers: providerRequest.headers,
      body: JSON.stringify(providerRequest.body),
      signal: AbortSignal.timeout(Number(body.timeoutMs || 30_000))
    });
    const raw = await response.text();
    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      payload = { raw };
    }
    if (!response.ok) {
      return sendJson(res, response.status, {
        error: payload?.error?.message || payload?.message || `模型请求失败（${response.status}）`,
        provider: payload
      });
    }
    return sendJson(res, 200, {
      text: extractText(payload, isAnthropic ? "anthropic" : "openai"),
      usage: payload.usage || null,
      reasoningTokens: Number(payload.usage?.completion_tokens_details?.reasoning_tokens || 0),
      providerRequestId: response.headers.get("x-request-id") || null
    });
  } catch (error) {
    return sendJson(res, 502, { error: error?.message || "模型服务连接失败" });
  }
}

function sendStreamEvent(res, event) {
  if (!res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`);
}

async function proxyModelStream(req, res) {
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return sendJson(res, 400, { error: "请求 JSON 无法解析" });
  }

  const {
    dialect = "openai",
    baseUrl,
    apiKey,
    model,
    messages = [],
    system = "",
    temperature = 0.7,
    maxTokens = 500,
    endpointPath,
    reasoningEffort
  } = body;
  if (!baseUrl || !model) return sendJson(res, 400, { error: "缺少 baseUrl 或 model" });
  if (!apiKey) return sendJson(res, 400, { error: "请先填写 API Key" });

  const isAnthropic = dialect === "anthropic";
  const providerRequest = buildProviderRequest({
    dialect,
    baseUrl,
    endpointPath,
    apiKey,
    model,
    messages,
    system,
    temperature,
    maxTokens,
    reasoningEffort,
    anthropicVersion: body.anthropicVersion || "2023-06-01",
    stream: true
  });

  let response;
  try {
    response = await fetch(providerRequest.url, {
      method: "POST",
      headers: providerRequest.headers,
      body: JSON.stringify(providerRequest.body),
      signal: AbortSignal.timeout(Number(body.timeoutMs || 30_000))
    });
  } catch (error) {
    return sendJson(res, 502, { error: error?.message || "模型服务连接失败" });
  }
  if (!response.ok) {
    const raw = await response.text();
    let payload;
    try { payload = JSON.parse(raw); } catch { payload = { raw }; }
    return sendJson(res, response.status, {
      error: payload?.error?.message || payload?.message || `模型请求失败（${response.status}）`,
      provider: payload
    });
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
    "Access-Control-Allow-Origin": "*"
  });
  const contentType = response.headers.get("content-type") || "";
  let fullText = "";
  let finished = false;
  const handleNormalized = (normalized) => {
    if (!normalized || res.writableEnded) return;
    if (normalized.type === "TEXT_DELTA") fullText += normalized.text;
    if (normalized.type === "ERROR") {
      sendStreamEvent(res, normalized);
      finished = true;
      return;
    }
    if (normalized.type === "TEXT_DONE") {
      if (finished) return;
      finished = true;
      sendStreamEvent(res, { type: "TEXT_DONE", text: fullText });
      return;
    }
    sendStreamEvent(res, normalized);
  };

  if (!contentType.includes("text/event-stream") || !response.body) {
    const raw = await response.text();
    let payload;
    try { payload = JSON.parse(raw); } catch { payload = null; }
    if (!payload) {
      sendStreamEvent(res, { type: "ERROR", code: "INVALID_PROVIDER_RESPONSE", message: "Provider 未返回可解析内容" });
    } else {
      fullText = extractText(payload, isAnthropic ? "anthropic" : "openai");
      sendStreamEvent(res, { type: "TEXT_DONE", text: fullText });
      finished = true;
    }
    res.end();
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventName = "message";
  let dataLines = [];
  const processLine = (line) => {
    if (line.startsWith("event:")) {
      eventName = line.slice(6).trim() || "message";
      return;
    }
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
      return;
    }
    if (!line.trim() && dataLines.length) {
      handleNormalized(normalizeProviderStreamEvent({ dialect, event: eventName, data: dataLines.join("\n") }));
      eventName = "message";
      dataLines = [];
    }
  };
  try {
    while (!finished) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || "";
      lines.forEach(processLine);
    }
    if (buffer) processLine(buffer);
    if (dataLines.length && !finished) handleNormalized(normalizeProviderStreamEvent({ dialect, event: eventName, data: dataLines.join("\n") }));
    if (!finished) handleNormalized({ type: "TEXT_DONE" });
  } catch (error) {
    if (!finished) sendStreamEvent(res, { type: "ERROR", code: "STREAM_READ_ERROR", message: error?.message || "流式读取失败" });
  } finally {
    res.end();
  }
}

function safeGameId(value) {
  const gameId = String(value || "");
  return /^[A-Za-z0-9_-]{1,80}$/.test(gameId) ? gameId : null;
}

async function handleStoredEvents(req, res) {
  if (req.method === "POST") {
    let body;
    try { body = JSON.parse(await readBody(req)); } catch { return sendJson(res, 400, { error: "事件 JSON 无法解析" }); }
    const gameId = safeGameId(body.gameId);
    if (!gameId) return sendJson(res, 400, { error: "gameId 不合法" });
    try {
      const stored = await appendStoredEvent(join(eventDir, `${gameId}.jsonl`), {
        sequence: body.sequence,
        gameId,
        type: body.type,
        visibility: body.visibility || "PUBLIC",
        audience: body.audience,
        payload: body.payload
      });
      return sendJson(res, 201, { ok: true, event: stored });
    } catch (error) {
      return sendJson(res, 400, { error: error?.message || "事件写入失败" });
    }
  }
  if (req.method === "GET") {
    const gameId = safeGameId((req.url || "").slice("/api/events/".length));
    if (!gameId) return sendJson(res, 400, { error: "gameId 不合法" });
    try { return sendJson(res, 200, { gameId, events: await readStoredEvents(join(eventDir, `${gameId}.jsonl`)) }); }
    catch (error) { return sendJson(res, 500, { error: error?.message || "事件读取失败" }); }
  }
  sendJson(res, 405, { error: "Method Not Allowed" });
}

async function serveStatic(req, res) {
  const requestPath = decodeURIComponent((req.url || "/").split("?")[0]);
  const relative = requestPath === "/" ? "index.html" : requestPath.replace(/^\/+/, "");
  const filePath = normalize(join(publicDir, relative));
  if (!filePath.startsWith(normalize(publicDir))) {
    return sendJson(res, 403, { error: "禁止访问" });
  }
  try {
    const data = await readFile(filePath);
    res.writeHead(200, {
      "Content-Type": mime[extname(filePath)] || "application/octet-stream",
      "Cache-Control": "no-cache"
    });
    res.end(data);
  } catch {
    sendJson(res, 404, { error: "页面不存在" });
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS"
    });
    return res.end();
  }
  if (req.method === "POST" && req.url === "/api/model") return proxyModel(req, res);
  if (req.method === "POST" && req.url === "/api/model-stream") return proxyModelStream(req, res);
  if ((req.method === "POST" && req.url === "/api/events") || (req.method === "GET" && req.url.startsWith("/api/events/"))) return handleStoredEvents(req, res);
  if (req.method === "GET") return serveStatic(req, res);
  sendJson(res, 405, { error: "Method Not Allowed" });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Werewolf demo running at http://127.0.0.1:${port}`);
});
