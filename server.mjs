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

function logServerError(scope, error, context = {}) {
  const details = Object.entries(context)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => `${key}=${String(value).slice(0, 160)}`)
    .join(" ");
  const message = String(error?.message || error || "未知错误");
  const stack = error?.stack && error.stack !== message ? `\n${error.stack}` : "";
  console.error(`[server ${new Date().toISOString()}] ${scope}${details ? ` ${details}` : ""}: ${message}${stack}`);
}

function modelLogContext(body, extra = {}) {
  return {
    requestId: body?.requestId,
    dialect: body?.dialect,
    model: body?.model,
    endpoint: body?.endpointPath,
    ...extra
  };
}

function emptyModelTextMessage(payload) {
  const reasoningOnly = Boolean(payload?.choices?.[0]?.message?.reasoning_content || payload?.reasoning_content);
  return reasoningOnly
    ? "模型只返回了推理内容，没有返回最终答案；请降低推理强度或提高输出上限"
    : "Provider 返回成功，但没有可用的最终文本";
}

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
  } catch (error) {
    logServerError("model.request-json", error, { method: req.method, path: req.url });
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
    logServerError("model.invalid-config", new Error("缺少 baseUrl 或 model"), modelLogContext(body));
    return sendJson(res, 400, { error: "缺少 baseUrl 或 model" });
  }
  if (!apiKey) {
    logServerError("model.invalid-config", new Error("请先填写 API Key"), modelLogContext(body));
    return sendJson(res, 400, { error: "请先填写 API Key" });
  }

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
      const message = payload?.error?.message || payload?.message || `模型请求失败（${response.status}）`;
      logServerError("model.provider-response", new Error(message), modelLogContext(body, { status: response.status }));
      return sendJson(res, response.status, {
        error: message,
        provider: payload
      });
    }
    const text = extractText(payload, isAnthropic ? "anthropic" : "openai");
    if (!text) {
      const message = emptyModelTextMessage(payload);
      logServerError("model.empty-response", new Error(message), modelLogContext(body, { status: response.status }));
      return sendJson(res, 502, { error: message, hasReasoningContent: message.startsWith("模型只返回") });
    }
    return sendJson(res, 200, {
      text,
      usage: payload.usage || null,
      reasoningTokens: Number(payload.usage?.completion_tokens_details?.reasoning_tokens || 0),
      providerRequestId: response.headers.get("x-request-id") || null
    });
  } catch (error) {
    logServerError("model.proxy", error, modelLogContext(body));
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
  } catch (error) {
    logServerError("model-stream.request-json", error, { method: req.method, path: req.url });
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
    logServerError("model-stream.invalid-config", new Error("缺少 baseUrl 或 model"), modelLogContext(body));
    return sendJson(res, 400, { error: "缺少 baseUrl 或 model" });
  }
  if (!apiKey) {
    logServerError("model-stream.invalid-config", new Error("请先填写 API Key"), modelLogContext(body));
    return sendJson(res, 400, { error: "请先填写 API Key" });
  }

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
    logServerError("model-stream.proxy", error, modelLogContext(body));
    return sendJson(res, 502, { error: error?.message || "模型服务连接失败" });
  }
  if (!response.ok) {
    const raw = await response.text();
    let payload;
    try { payload = JSON.parse(raw); } catch { payload = { raw }; }
    const message = payload?.error?.message || payload?.message || `模型请求失败（${response.status}）`;
    logServerError("model-stream.provider-response", new Error(message), modelLogContext(body, { status: response.status }));
    return sendJson(res, response.status, {
      error: message,
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
      logServerError("model-stream.provider-stream", new Error(normalized.message || "Provider 流式请求失败"), modelLogContext(body));
      sendStreamEvent(res, normalized);
      finished = true;
      return;
    }
    if (normalized.type === "TEXT_DONE") {
      if (finished) return;
      if (!fullText.trim()) {
        const message = "模型流式响应没有最终答案；请降低推理强度或提高输出上限";
        logServerError("model-stream.empty-response", new Error(message), modelLogContext(body));
        sendStreamEvent(res, { type: "ERROR", code: "EMPTY_MODEL_TEXT", message });
        finished = true;
        return;
      }
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
      logServerError("model-stream.invalid-response", new Error("Provider 未返回可解析内容"), modelLogContext(body));
      sendStreamEvent(res, { type: "ERROR", code: "INVALID_PROVIDER_RESPONSE", message: "Provider 未返回可解析内容" });
    } else {
      fullText = extractText(payload, isAnthropic ? "anthropic" : "openai");
      if (!fullText) {
        const message = emptyModelTextMessage(payload);
        logServerError("model-stream.empty-response", new Error(message), modelLogContext(body));
        sendStreamEvent(res, { type: "ERROR", code: "EMPTY_MODEL_TEXT", message });
      } else {
        sendStreamEvent(res, { type: "TEXT_DONE", text: fullText });
      }
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
    logServerError("model-stream.read", error, modelLogContext(body));
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
      logServerError("events.write", error, { gameId });
      return sendJson(res, 400, { error: error?.message || "事件写入失败" });
    }
  }
  if (req.method === "GET") {
    const gameId = safeGameId((req.url || "").slice("/api/events/".length));
    if (!gameId) return sendJson(res, 400, { error: "gameId 不合法" });
    try { return sendJson(res, 200, { gameId, events: await readStoredEvents(join(eventDir, `${gameId}.jsonl`)) }); }
    catch (error) {
      logServerError("events.read", error, { gameId });
      return sendJson(res, 500, { error: error?.message || "事件读取失败" });
    }
  }
  sendJson(res, 405, { error: "Method Not Allowed" });
}

async function handleClientError(req, res) {
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch (error) {
    logServerError("client-error.request-json", error);
    return sendJson(res, 400, { error: "客户端错误日志 JSON 无法解析" });
  }
  const message = String(body.message || "未知客户端错误").slice(0, 500);
  const context = {
    source: String(body.source || "runtime").slice(0, 80),
    day: Number(body.day) || 0,
    phase: String(body.phase || "").slice(0, 40),
    playerId: String(body.playerId || "").slice(0, 20),
    kind: String(body.kind || "").slice(0, 40)
  };
  const at = String(body.at || new Date().toISOString()).slice(0, 40);
  const diagnostic = String(body.diagnostic || "").slice(0, 500);
  const stack = String(body.stack || "").slice(0, 1200);
  console.error(`[client ${at}] ${context.source} day=${context.day} phase=${context.phase || "unknown"}${context.playerId ? ` player=${context.playerId}` : ""}${context.kind ? ` kind=${context.kind}` : ""}: ${message}`);
  if (diagnostic) console.error(`[client ${at}] diagnostic: ${diagnostic}`);
  if (stack) console.error(stack);
  return sendJson(res, 202, { ok: true });
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
  if (req.method === "POST" && req.url === "/api/client-errors") return handleClientError(req, res);
  if ((req.method === "POST" && req.url === "/api/events") || (req.method === "GET" && req.url.startsWith("/api/events/"))) return handleStoredEvents(req, res);
  if (req.method === "GET") return serveStatic(req, res);
  sendJson(res, 405, { error: "Method Not Allowed" });
});

server.on("error", (error) => {
  logServerError("server", error, { port });
  process.exitCode = 1;
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Werewolf demo running at http://127.0.0.1:${port}`);
});
