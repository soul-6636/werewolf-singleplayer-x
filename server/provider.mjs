export function joinUrl(baseUrl, path) {
  return `${String(baseUrl || "").replace(/\/+$/, "")}/${String(path || "").replace(/^\/+/, "")}`;
}

export function buildProviderRequest({
  dialect = "openai",
  baseUrl,
  endpointPath,
  apiKey,
  model,
  system = "",
  messages = [],
  temperature = 0.7,
  maxTokens = 500,
  anthropicVersion = "2023-06-01",
  reasoningEffort = "",
  stream = false
}) {
  const isAnthropic = dialect === "anthropic";
  const path = endpointPath || (isAnthropic ? "/v1/messages" : "/chat/completions");
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json"
  };
  if (isAnthropic) {
    headers["x-api-key"] = apiKey;
    headers["anthropic-version"] = anthropicVersion;
  } else {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  const body = isAnthropic
    ? {
        model,
        system,
        messages: messages.filter((message) => message.role !== "system"),
        max_tokens: maxTokens,
        temperature,
        stream
      }
    : {
        model,
        messages: [
          ...(system ? [{ role: "system", content: system }] : []),
          ...messages.filter((message) => message.role !== "system")
        ],
        temperature,
        max_tokens: maxTokens,
        stream
      };
  if (!isAnthropic && ["low", "medium", "high"].includes(reasoningEffort)) {
    body.reasoning_effort = reasoningEffort;
  }
  return { url: joinUrl(baseUrl, path), headers, body };
}

export function normalizeProviderStreamEvent({ dialect = "openai", event = "message", data = "" } = {}) {
  const raw = String(data || "").trim();
  if (!raw) return null;
  if (dialect !== "anthropic" && raw === "[DONE]") return { type: "TEXT_DONE" };
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return { type: "ERROR", code: "INVALID_STREAM_JSON", message: "Provider 流式事件不是合法 JSON" };
  }
  if (dialect === "anthropic") {
    if (event === "error" || payload?.type === "error") {
      return { type: "ERROR", code: payload?.error?.type || "PROVIDER_ERROR", message: payload?.error?.message || "Provider 流式请求失败" };
    }
    if (event === "content_block_delta" || payload?.type === "content_block_delta") {
      const text = payload?.delta?.text;
      return typeof text === "string" && text ? { type: "TEXT_DELTA", text } : null;
    }
    if (event === "message_delta" || payload?.type === "message_delta") {
      const usage = payload?.usage;
      return usage ? { type: "USAGE", inputTokens: usage.input_tokens, outputTokens: usage.output_tokens } : null;
    }
    if (event === "message_stop" || payload?.type === "message_stop") return { type: "TEXT_DONE" };
    return null;
  }
  if (payload?.error) return { type: "ERROR", code: "PROVIDER_ERROR", message: payload.error.message || "Provider 流式请求失败" };
  const delta = payload?.choices?.[0]?.delta?.content;
  if (typeof delta === "string" && delta) return { type: "TEXT_DELTA", text: delta };
  const usage = payload?.usage;
  if (usage) return { type: "USAGE", inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens };
  if (payload?.choices?.[0]?.finish_reason) return { type: "TEXT_DONE" };
  return null;
}

export function extractText(payload, dialect) {
  if (dialect === "anthropic") {
    return (payload?.content || [])
      .filter((block) => block?.type === "text")
      .map((block) => block.text || "")
      .join("")
      .trim();
  }
  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content === "string") return content.trim();
  if (Array.isArray(content)) return content.map((part) => part?.text || "").join("").trim();
  return "";
}
