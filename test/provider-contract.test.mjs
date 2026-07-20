import test from "node:test";
import assert from "node:assert/strict";
import { buildProviderRequest, extractText, joinUrl, normalizeProviderStreamEvent } from "../server/provider.mjs";

test("joins provider URLs without duplicate slashes", () => {
  assert.equal(joinUrl("https://provider.example/v1/", "/chat/completions"), "https://provider.example/v1/chat/completions");
});

test("builds OpenAI-compatible chat request", () => {
  const request = buildProviderRequest({
    dialect: "openai",
    baseUrl: "https://api.example/v1",
    apiKey: "secret",
    model: "demo-model",
    system: "system prompt",
    messages: [{ role: "system", content: "ignored" }, { role: "user", content: "hello" }],
    temperature: 0.3,
    maxTokens: 80,
    reasoningEffort: "low"
  });
  assert.equal(request.url, "https://api.example/v1/chat/completions");
  assert.equal(request.headers.Authorization, "Bearer secret");
  assert.equal(request.body.messages[0].role, "system");
  assert.equal(request.body.messages[0].content, "system prompt");
  assert.deepEqual(request.body.messages[1], { role: "user", content: "hello" });
  assert.equal(request.body.stream, false);
  assert.equal(request.body.max_tokens, 80);
  assert.equal(request.body.reasoning_effort, "low");
});

test("builds Anthropic-compatible messages request", () => {
  const request = buildProviderRequest({
    dialect: "anthropic",
    baseUrl: "https://api.example",
    endpointPath: "/messages",
    apiKey: "secret",
    model: "demo-model",
    system: "system prompt",
    messages: [{ role: "system", content: "ignored" }, { role: "user", content: "hello" }],
    anthropicVersion: "2024-01-01"
  });
  assert.equal(request.url, "https://api.example/messages");
  assert.equal(request.headers["x-api-key"], "secret");
  assert.equal(request.headers["anthropic-version"], "2024-01-01");
  assert.equal(request.body.system, "system prompt");
  assert.deepEqual(request.body.messages, [{ role: "user", content: "hello" }]);
  assert.equal(request.body.stream, false);
  assert.equal("reasoning_effort" in request.body, false);
});

test("normalizes OpenAI and Anthropic text responses", () => {
  assert.equal(extractText({ choices: [{ message: { content: '  {"ok":true}  ' } }] }, "openai"), '{"ok":true}');
  assert.equal(extractText({ choices: [{ message: { content: [{ text: "a" }, { text: "b" }] } }] }, "openai"), "ab");
  assert.equal(extractText({ choices: [{ message: { content: "", reasoning_content: "hidden reasoning" } }] }, "openai"), "");
  assert.equal(extractText({ content: [{ type: "tool_use", input: {} }, { type: "text", text: " hello " }] }, "anthropic"), "hello");
});

test("builds streaming requests without changing provider dialect headers", () => {
  const openai = buildProviderRequest({ dialect: "openai", baseUrl: "https://api.example", apiKey: "secret", model: "demo", stream: true });
  const anthropic = buildProviderRequest({ dialect: "anthropic", baseUrl: "https://api.example", apiKey: "secret", model: "demo", stream: true });
  assert.equal(openai.body.stream, true);
  assert.equal(anthropic.body.stream, true);
  assert.equal(openai.headers.Authorization, "Bearer secret");
  assert.equal(anthropic.headers["x-api-key"], "secret");
});

test("normalizes OpenAI and Anthropic stream events", () => {
  assert.deepEqual(normalizeProviderStreamEvent({ dialect: "openai", data: JSON.stringify({ choices: [{ delta: { content: "片段" } }] }) }), { type: "TEXT_DELTA", text: "片段" });
  assert.deepEqual(normalizeProviderStreamEvent({ dialect: "openai", data: "[DONE]" }), { type: "TEXT_DONE" });
  assert.deepEqual(normalizeProviderStreamEvent({ dialect: "anthropic", event: "content_block_delta", data: JSON.stringify({ delta: { text: "片段" } }) }), { type: "TEXT_DELTA", text: "片段" });
  assert.deepEqual(normalizeProviderStreamEvent({ dialect: "anthropic", event: "message_stop", data: JSON.stringify({ type: "message_stop" }) }), { type: "TEXT_DONE" });
  assert.equal(normalizeProviderStreamEvent({ dialect: "openai", data: "not-json" }).type, "ERROR");
});
