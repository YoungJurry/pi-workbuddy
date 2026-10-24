import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import { createWorkbuddyProvider } from "../src/native-provider.js";
import { ORIGIN, createNativeClient } from "../src/native-client.js";

// Optional host integration. No dependencies installed and no real credentials used.
const dist = process.env.PI_AI_TEST_PATH;
const hostTest = (name, fn) => test(name, { skip: !dist && "Set PI_AI_TEST_PATH to the installed pi-ai/dist directory" }, fn);
async function setup(fetch, catalog) {
  const host = await import(pathToFileURL(join(dist, "index.js")).href);
  const api = await import(pathToFileURL(join(dist, "api/openai-completions.js")).href);
  const credentials = new host.InMemoryCredentialStore();
  await credentials.modify("workbuddy", async () => ({
    type: "oauth", origin: ORIGIN, access: "SYNTHETIC_ACCESS", refresh: "SYNTHETIC_REFRESH",
    expires: Date.now() + 3600000, userId: "mock-user",
  }));
  const models = host.createModels({ credentials });
  models.setProvider(createWorkbuddyProvider({ api, fetch,
    ...(catalog ? { client: { async catalog() { return { models: catalog }; } } } : {}),
  }));
  if (catalog) assert.equal((await models.refresh({ providers: ["workbuddy"], allowNetwork: true, force: true })).errors.size, 0);
  return { models, model: models.getModels("workbuddy")[0] };
}
function sse(values) {
  return new Response(values.map(value => "data: " + JSON.stringify(value) + "\n\n").join("") + "data: [DONE]\n\n", {
    headers: { "Content-Type": "text/event-stream" },
  });
}
const chunk = (delta, finish_reason = null) => ({ id: "mock-response", choices: [{ index: 0, delta, finish_reason }] });
const user = { role: "user", content: "Read a.txt", timestamp: Date.now() };

hostTest("Pi host: tool-call round trip, reasoning, Unicode, final usage, and instrumentation", async () => {
  let calls = 0;
  const bodies = [];
  const { models, model } = await setup(async (url, options) => {
    assert.equal(String(url), ORIGIN + "/v2/chat/completions");
    assert.equal(options.headers.get("Authorization"), "Bearer SYNTHETIC_ACCESS");
    assert.equal(options.headers.get("X-User-Id"), "mock-user");
    assert.equal(options.headers.get("X-Domain"), "www.workbuddy.ai");
    assert.equal(options.redirect, "error");
    const body = JSON.parse(gunzipSync(options.body));
    bodies.push(body);
    calls++;
    return calls === 1 ? sse([
      chunk({ reasoning_content: "Inspect the file 😀" }),
      chunk({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "read", arguments: '{"path":' } }] }),
      chunk({ tool_calls: [{ index: 0, id: "call_1", function: { arguments: '"a.txt"}' } }] }, "tool_calls"),
      { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, prompt_tokens_details: { cached_tokens: 2 } } },
    ]) : sse([chunk({ content: "File contents: hello 😀" }), chunk({}, "stop"),
      { choices: [], usage: { prompt_tokens: 20, completion_tokens: 6, total_tokens: 26 } }]);
  });
  const context = { systemPrompt: "Mock test only.", messages: [user], tools: [{
    name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  }] };
  const observations = { payload: 0, response: 0, event: 0 };
  const options = {
    onPayload(body) { observations.payload++; assert.equal(body.model, "default-model"); },
    onResponse(response) { observations.response++; assert.equal(response.status, 200); },
    onProviderStreamEvent() { observations.event++; },
  };
  const first = await models.completeSimple(model, context, options);
  assert.equal(first.stopReason, "toolUse", first.errorMessage);
  const call = first.content.find(block => block.type === "toolCall");
  assert.equal(call.id, "call_1");
  assert.equal(call.name, "read");
  assert.deepEqual(call.arguments, { path: "a.txt" });
  assert.equal(first.content.find(block => block.type === "thinking").thinking, "Inspect the file 😀");
  assert.equal(first.usage.totalTokens, 15);
  assert.equal(first.usage.cacheRead, 2);
  const second = await models.completeSimple(model, { ...context, messages: [user, first, {
    role: "toolResult", toolCallId: call.id, toolName: call.name, content: [{ type: "text", text: "hello" }], isError: false, timestamp: Date.now(),
  }] }, options);
  assert.equal(second.stopReason, "stop", second.errorMessage);
  assert.equal(second.content[0].text, "File contents: hello 😀");
  assert.equal(second.usage.totalTokens, 26);
  assert.equal(bodies[0].messages[0].role, "system");
  assert.equal(bodies[0].stream_options.include_usage, true);
  assert.ok(bodies[0].tools.some(tool => tool.function.name === "read"));
  assert.ok(bodies[1].messages.some(message => message.role === "tool" && message.tool_call_id === "call_1"));
  assert.equal(observations.payload, 2);
  assert.equal(observations.response, 2);
  assert.ok(observations.event >= 6);
});

hostTest("Pi host: native login persistence, auth headers, and locked token refresh", async () => {
  const host = await import(pathToFileURL(join(dist, "index.js")).href);
  const api = await import(pathToFileURL(join(dist, "api/openai-completions.js")).href);
  const credentials = new host.InMemoryCredentialStore();
  const models = host.createModels({ credentials });
  let refreshes = 0;
  const client = createNativeClient({ fetch: async input => {
    const path = new URL(input).pathname;
    const data = path.endsWith("/auth/state") ? { state: "mock-state", authUrl: ORIGIN + "/login" } :
      path.endsWith("/login/account") ? { uid: "user-1" } :
      { accessToken: path.endsWith("/refresh") ? "ROTATED" : "FIRST", refreshToken: "REFRESH", expiresIn: 3600, domain: "workbuddy.ai" };
    if (path.endsWith("/refresh")) refreshes++;
    return new Response(JSON.stringify({ code: 0, data }));
  } });
  models.setProvider(createWorkbuddyProvider({ api, client }));
  await models.login("workbuddy", "oauth", { notify() {}, prompt: async () => { throw new Error("Unexpected prompt"); } });
  const stored = await credentials.read("workbuddy");
  assert.equal(stored.userId, "user-1");
  assert.equal(stored.access, "FIRST");
  await credentials.modify("workbuddy", async current => ({ ...current, expires: Date.now() - 1000 }));
  const [first, second] = await Promise.all([models.getAuth("workbuddy"), models.getAuth("workbuddy")]);
  assert.equal(refreshes, 1);
  assert.equal(first.auth.apiKey, "ROTATED");
  assert.equal(second.auth.headers["X-User-Id"], "user-1");
  assert.equal(second.auth.headers["X-Domain"], "workbuddy.ai");
  assert.equal((await credentials.read("workbuddy")).access, "ROTATED");
});

hostTest("Pi host: refresh discovers previously unknown model IDs without code changes", async () => {
  const host = await import(pathToFileURL(join(dist, "index.js")).href);
  const credentials = new host.InMemoryCredentialStore();
  await credentials.modify("workbuddy", async () => ({
    type: "oauth", origin: ORIGIN, access: "SYNTHETIC_ACCESS", refresh: "SYNTHETIC_REFRESH",
    expires: Date.now() + 3600000, userId: "mock-user",
  }));
  let catalog = [{ id: "existing-model", supportsToolCall: true }, { id: "deepseek-v4.1-flash-sg", supportsToolCall: true }];
  let requests = 0;
  const provider = createWorkbuddyProvider({
    api: { stream() { throw new Error("Inference must not run"); }, streamSimple() { throw new Error("Inference must not run"); } },
    client: { async catalog() { requests++; return { models: catalog }; } },
  });
  const models = host.createModels({ credentials });
  models.setProvider(provider);
  const refresh = () => models.refresh({ providers: ["workbuddy"], allowNetwork: true, force: true });
  assert.equal((await refresh()).errors.size, 0);
  assert.deepEqual(models.getModels("workbuddy").map(model => model.id), ["existing-model"]);
  catalog = [...catalog, { id: "future-model-never-bundled-v99", supportsToolCall: true, maxInputTokens: 128000 },
    { id: "deepseek-future-v99-sg", supportsToolCall: true }];
  assert.equal((await refresh()).errors.size, 0);
  assert.ok((await models.getAvailable("workbuddy")).some(model => model.id === "future-model-never-bundled-v99"));
  assert.equal(models.getModel("workbuddy", "future-model-never-bundled-v99").contextWindow, 128000);
  assert.deepEqual(models.getModels("workbuddy").map(model => model.id), ["existing-model", "future-model-never-bundled-v99"]);
  await models.refresh({ providers: ["workbuddy"], allowNetwork: false });
  assert.equal(requests, 2, "offline refresh must not make discovery requests");
});

hostTest("Pi host: near-full context clamps output even when sampling and hooks request more", async () => {
  let sent;
  const { models, model } = await setup(async (_url, options) => {
    sent = JSON.parse(gunzipSync(options.body));
    return sse([chunk({}, "stop")]);
  });
  const timestamp = Date.now();
  const previous = {
    role: "assistant", api: model.api, provider: model.provider, model: model.id,
    content: [{ type: "text", text: "Previous response." }], timestamp, stopReason: "stop",
    usage: { input: 28000, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 28000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
  const result = await models.completeSimple(model, { messages: [previous, { ...user, timestamp }] }, {
    maxTokens: 128000, samplingParams: { max_tokens: 900000 },
    onPayload(payload) { payload.max_tokens = 900000; return payload; },
  });
  assert.equal(result.stopReason, "stop", result.errorMessage);
  assert.ok(sent.max_tokens > 0);
  assert.ok(sent.max_tokens <= model.contextWindow - 28000 - 4096,
    "output must retain Pi's remaining-context estimate and safety margin");
  assert.ok(sent.max_tokens <= model.maxTokens);
});

hostTest("Pi host: empty valid response versus truncated stream", async () => {
  for (const [values, expected] of [[[chunk({}, "stop")], "stop"], [[chunk({ content: "unfinished" })], "error"]]) {
    const { models, model } = await setup(async () => sse(values));
    const result = await models.completeSimple(model, { messages: [user] });
    assert.equal(result.stopReason, expected, result.errorMessage);
    if (expected === "error") assert.match(result.errorMessage, /finish_reason/);
  }
});

hostTest("Pi host: HTTP errors remain sanitized and abort terminates inference", async () => {
  const { models, model } = await setup(async (_url, { signal }) => {
    await new Promise((resolve, reject) => {
      if (signal.aborted) reject(new Error("aborted"));
      else signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    });
  });
  const controller = new AbortController();
  const pending = models.completeSimple(model, { messages: [user] }, { signal: controller.signal });
  setTimeout(() => controller.abort(), 25);
  assert.equal((await pending).stopReason, "aborted");
  const failed = await setup(async () => new Response('{"error":{"message":"SECRET_TOKEN","code":12003}}', { status: 429 }));
  const result = await failed.models.completeSimple(failed.model, { messages: [user] }, { maxRetries: 0 });
  assert.equal(result.stopReason, "error");
  assert.ok(!result.errorMessage.includes("SECRET_TOKEN"));
  assert.match(result.errorMessage, /429/);
});

hostTest("Pi host: full DeepSeek context, image input, tools, and low/high/max reach the wire", async () => {
  const bodies = [];
  const { models, model } = await setup(async (_url, options) => {
    bodies.push(JSON.parse(gunzipSync(options.body)));
    return sse([chunk({ content: "Mock only." }), chunk({}, "stop")]);
  }, [{ id: "deepseek-v4.1-flash", maxInputTokens: 1000000, maxOutputTokens: 128000,
    onlyReasoning: true, contextWindow: { defaultLength: 300000, supportedLengths: [300000, 1000000] } }]);
  assert.equal(model.contextWindow, 1048576);
  assert.equal(model.maxTokens, 393216);
  const context = { messages: [{ role: "user", timestamp: Date.now(), content: [
    { type: "text", text: "Describe this image; mock transport only." },
    { type: "image", mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1sAAAAASUVORK5CYII=" },
  ] }], tools: [{ name: "read", description: "Read a file", parameters: { type: "object", properties: {} } }] };
  for (const reasoning of ["low", "high", "max"]) {
    const result = await models.completeSimple(model, context, { reasoning });
    assert.equal(result.stopReason, "stop", result.errorMessage);
    const body = bodies.at(-1);
    assert.equal(body.reasoning_effort, reasoning);
    assert.equal(body.max_tokens, 393216);
    assert.ok(body.tools.some(tool => tool.function.name === "read"));
    assert.ok(body.messages.some(message => Array.isArray(message.content) &&
      message.content.some(part => part.type === "image_url" && part.image_url.url.startsWith("data:image/png;base64,"))));
  }
});

hostTest("Pi host: Kimi K2.6 sends thinking toggle without inventing reasoning_effort support", async () => {
  let sent;
  const { models, model } = await setup(async (_url, options) => {
    sent = JSON.parse(gunzipSync(options.body));
    return sse([chunk({}, "stop")]);
  }, [{ id: "kimi-k2.6" }]);
  const result = await models.completeSimple(model, { messages: [user] }, { reasoning: "high", maxTokens: 8000 });
  assert.equal(result.stopReason, "stop", result.errorMessage);
  assert.deepEqual(sent.thinking, { type: "enabled" });
  assert.equal(sent.reasoning_effort, undefined);
  assert.equal(sent.max_tokens, 8000);
});
