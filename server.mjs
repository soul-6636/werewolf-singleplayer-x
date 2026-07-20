import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const publicDir = join(root, "public");
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

function joinUrl(baseUrl, path) {
  return `${String(baseUrl || "").replace(/\/+$/, "")}/${String(path || "").replace(/^\/+/, "")}`;
}

function extractText(payload, dialect) {
  if (dialect === "anthropic") {
    return (payload?.content || [])
      .filter((block) => block?.type === "text")
      .map((block) => block.text || "")
      .join("")
      .trim();
  }
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) {
    return content.map((part) => part?.text || "").join("").trim();
  }
  return "";
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
    endpointPath
  } = body;

  if (!baseUrl || !model) {
    return sendJson(res, 400, { error: "缺少 baseUrl 或 model" });
  }
  if (!apiKey) return sendJson(res, 400, { error: "请先填写 API Key" });

  const isAnthropic = dialect === "anthropic";
  const path = endpointPath || (isAnthropic ? "/v1/messages" : "/chat/completions");
  const url = joinUrl(baseUrl, path);
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json"
  };
  if (isAnthropic) {
    headers["x-api-key"] = apiKey;
    headers["anthropic-version"] = body.anthropicVersion || "2023-06-01";
  } else {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const requestBody = isAnthropic
    ? {
        model,
        system,
        messages: messages.filter((message) => message.role !== "system"),
        max_tokens: maxTokens,
        temperature,
        stream: false
      }
    : {
        model,
        messages: [
          ...(system ? [{ role: "system", content: system }] : []),
          ...messages.filter((message) => message.role !== "system")
        ],
        temperature,
        max_tokens: maxTokens,
        stream: false
      };

  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(requestBody),
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
      providerRequestId: response.headers.get("x-request-id") || null
    });
  } catch (error) {
    return sendJson(res, 502, { error: error?.message || "模型服务连接失败" });
  }
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
  if (req.method === "GET") return serveStatic(req, res);
  sendJson(res, 405, { error: "Method Not Allowed" });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Werewolf demo running at http://127.0.0.1:${port}`);
});
