import assert from "node:assert/strict";
import { test } from "node:test";
import { gunzipSync } from "node:zlib";
import { createNativeClient, accountHeaders, ORIGIN, BASE_URL } from "../src/native-client.js";
import { projectModels } from "../src/native-models.js";
import { createChatFetch, normalizeSse } from "../src/native-transport.js";
import { createWorkbuddyProvider, registerNativeCommands } from "../src/native-provider.js";

const credential = () => ({ type: "oauth", origin: ORIGIN, access: "ACCESS", refresh: "REFRESH", expires: Date.now() + 3600000, userId: "user-1" });
const json = (data, code = 0, status = 200) => new Response(JSON.stringify({ code, data }), { status, headers: { "Content-Type": "application/json" } });
const token = () => ({ accessToken: "NEW_ACCESS", refreshToken: "NEW_REFRESH", expiresIn: 3600, domain: "www.workbuddy.ai" });
function scripted(steps) {
  const requests = [];
  return {
    requests,
    fetch: async (input, init) => {
      requests.push({ url: new URL(input), ...init });
      assert.equal(new URL(input).origin, ORIGIN);
      assert.equal(init.redirect, "error");
      assert.ok(init.signal);
      const next = steps.shift();
      assert.ok(next, "unexpected request");
      return typeof next === "function" ? next(input, init) : next;
    },
  };
}

test("native login polls pending token/account and emits browser interaction", async () => {
  const f = scripted([
    json({ authUrl: ORIGIN + "/login?state=state-secret", state: "state-secret" }),
    json(null, 11217), json(token()), json(null, 12151), json({ uid: "user-1", enterpriseId: "tenant-1", nickname: "not-stored" }),
  ]);
  const events = [];
  const result = await createNativeClient({ fetch: f.fetch, pollIntervalMs: 1 }).login({ notify: e => events.push(e) });
  assert.equal(result.type, "oauth");
  assert.equal(result.origin, ORIGIN);
  assert.equal(result.access, "NEW_ACCESS");
  assert.equal(result.refresh, "NEW_REFRESH");
  assert.equal(result.enterpriseId, "tenant-1");
  assert.equal(result.nickname, undefined);
  assert.ok(result.expires > Date.now());
  assert.equal(events.find(e => e.type === "auth_url").url, ORIGIN + "/login?state=state-secret");
  assert.equal(f.requests[0].url.pathname, "/v2/plugin/auth/state");
  assert.equal(f.requests[0].url.searchParams.get("platform"), "workbuddy-ai");
  assert.equal(f.requests[0].method, "POST");
  assert.equal(f.requests[4].headers.Authorization, "Bearer NEW_ACCESS");
});

test("login rejects untrusted browser URL before polling", async () => {
  const f = scripted([json({ authUrl: "https://attacker.example/login", state: "secret" })]);
  await assert.rejects(createNativeClient({ fetch: f.fetch }).login({ notify() {} }), /untrusted login URL/);
  assert.equal(f.requests.length, 1);
});

test("login abort and overall timeout stop polling", async () => {
  for (const manual of [true, false]) {
    const controller = new AbortController();
    let calls = 0;
    const client = createNativeClient({
      loginTimeoutMs: 30, pollIntervalMs: 5,
      fetch: async (_url, options) => {
        options.signal.throwIfAborted();
        calls++;
        if (calls === 1) return json({ authUrl: ORIGIN + "/login", state: "pending" });
        if (manual) controller.abort();
        return json(null, 11217);
      },
    });
    await assert.rejects(client.login({ signal: controller.signal, notify() {} }));
    assert.ok(calls < 20);
  }
});

test("login refuses invalid token expiry without returning credentials", async () => {
  const bad = token(); delete bad.expiresIn;
  const f = scripted([json({ authUrl: ORIGIN + "/login", state: "s" }), json(bad), json({ uid: "u" })]);
  await assert.rejects(createNativeClient({ fetch: f.fetch }).login({ notify() {} }), /expiry/);
});

test("refresh binds origin and retains account/rotated token metadata", async () => {
  const f = scripted([json(token())]);
  const client = createNativeClient({ fetch: f.fetch });
  const result = await client.refresh(credential());
  assert.equal(result.userId, "user-1");
  assert.equal(result.refresh, "NEW_REFRESH");
  assert.equal(f.requests[0].headers["X-Refresh-Token"], "REFRESH");
  assert.equal(f.requests[0].url.pathname, "/v2/plugin/auth/token/refresh");
  await assert.rejects(client.refresh({ ...credential(), origin: "https://evil.example" }), /different endpoint/);
  await assert.rejects(client.refresh({ ...credential(), refresh: "" }), /Run \/login/);
  assert.equal(f.requests.length, 1);
});

test("native errors never echo server response, URL state, or tokens", async () => {
  const f = scripted([new Response('{"code":11212,"msg":"SECRET_TOKEN"}', { status: 403 })]);
  await assert.rejects(createNativeClient({ fetch: f.fetch }).catalog(credential()), error =>
    /403/.test(error.message) && /11212/.test(error.message) && !/SECRET/.test(error.message));
  assert.throws(() => accountHeaders({ ...credential(), access: "token\r\nInjected: true" }), /Invalid/);
});

test("catalog projection excludes external endpoints, disabled and tool-less models", () => {
  const models = projectModels({ models: [
    { id: "hy3", name: "Hy3", supportsToolCall: true, supportsReasoning: true, onlyReasoning: true,
      maxInputTokens: 1000000, maxOutputTokens: 64000, contextWindow: { defaultLength: 192000 },
      reasoning: { defaultEffort: "high", supportedEfforts: ["low", "high"] } },
    { id: "url", url: "https://evil.example" }, { id: "disabled", disabled: true },
    { id: "notools", supportsToolCall: false }, { id: "hy3" }, { id: "key", apiKey: "SECRET" },
  ], prompts: [{ malicious: true }] });
  assert.equal(models.length, 1);
  assert.equal(models[0].contextWindow, 1000000);
  assert.equal(models[0].maxTokens, 128000); // Vendor maximum supplements the smaller gateway output default.
  assert.equal(models[0].baseUrl, BASE_URL);
  assert.equal(models[0].thinkingLevelMap.off, null);
  assert.equal(models[0].thinkingLevelMap.medium, null);
  assert.equal(models[0].samplingParams.reasoning_effort, undefined); // Do not override the user-selected effort.
  assert.equal(models[0].prompts, undefined);
  assert.throws(() => projectModels({ models: [] }), /Existing catalog retained/);
  assert.equal(projectModels({ models: [{ id: "a" }, { id: "b" }], availableModels: ["b"] })[0].id, "b");
});

test("provider refresh uses generation-checked publication and retains last-good on error", async () => {
  let fail = false, accept = false;
  const provider = createWorkbuddyProvider({ api: { stream() {}, streamSimple() {} }, client: {
    async catalog() { if (fail) throw new Error("offline"); return { models: [{ id: "live" }] }; },
  } });
  const context = { credential: credential(), allowNetwork: true, force: true, signal: new AbortController().signal,
    publish: async ({ update }) => { if (accept) update(); return accept; } };
  await provider.refreshModels(context);
  assert.equal(provider.getModels()[0].id, "default-model");
  accept = true;
  await provider.refreshModels(context);
  assert.equal(provider.getModels()[0].id, "live");
  fail = true;
  await assert.rejects(provider.refreshModels(context));
  assert.equal(provider.getModels()[0].id, "live");
  await provider.refreshModels({ ...context, allowNetwork: false });
});

test("native stream delegates hooks, fixes endpoint, and installs guarded fetch", async () => {
  const marker = {};
  let captured;
  const api = { stream(...args) { captured = args; return marker; }, streamSimple(...args) { captured = args; return marker; } };
  const provider = createWorkbuddyProvider({ api });
  const hook = () => {};
  const options = { apiKey: "ACCESS", onPayload: hook, onResponse: hook, onProviderStreamEvent: hook, signal: AbortSignal.abort() };
  assert.equal(provider.streamSimple({ ...provider.getModels()[0], baseUrl: "https://evil.example" }, {}, options), marker);
  assert.equal(captured[0].baseUrl, BASE_URL);
  assert.equal((await captured[2].onPayload({ max_tokens: 999999 }, captured[0])).max_tokens, 4096);
  assert.equal(captured[2].onResponse, hook);
  assert.equal(captured[2].onProviderStreamEvent, hook);
  assert.equal(captured[2].signal, options.signal);
  assert.equal(typeof captured[2].fetch, "function");
  assert.equal(captured[2].maxRetries, 0);
});

test("SSE normalization handles byte-split Unicode and fragmented repeated tool IDs", async () => {
  const frames = [
    { choices: [{ delta: { content: "Hello 😀", tool_calls: [{ id: "call_1", function: { name: "read", arguments: '{"path":' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ id: "call_1", function: { arguments: '"a"}' } }] }, finish_reason: "tool_calls" }] },
    { choices: [], usage: { prompt_tokens: 10, completion_tokens: 4 } },
  ];
  const bytes = new TextEncoder().encode(frames.map(f => "data: " + JSON.stringify(f) + "\r\n\r\n").join("") + "data: [DONE]\n\n");
  const source = new ReadableStream({ start(c) { for (const byte of bytes) c.enqueue(Uint8Array.of(byte)); c.close(); } });
  const text = await new Response(normalizeSse(source)).text();
  assert.match(text, /Hello 😀/);
  const parsed = text.split("\n\n").filter(x => x.startsWith("data: {")).map(x => JSON.parse(x.slice(6)));
  assert.equal(parsed[0].choices[0].delta.tool_calls[0].index, 0);
  assert.equal(parsed[1].choices[0].delta.tool_calls[0].index, 0);
  assert.equal(parsed[1].choices[0].delta.tool_calls[0].id, undefined);
  assert.equal(parsed[2].usage.prompt_tokens, 10);
});

test("malformed/truncated stream and explicit stream errors reject safely", async () => {
  for (const text of ['data: {oops}\n\n', 'data: {"error":{"message":"SECRET"}}\n\n']) {
    const source = new Response(text).body;
    await assert.rejects(new Response(normalizeSse(source)).text(), error => !error.message.includes("SECRET"));
  }
});

test("transport gzip, privacy/client headers and endpoint allowlist", async () => {
  let calls = 0;
  const fetch = createChatFetch({ sessionId: "session-id", fetch: async (url, options) => {
    calls++;
    assert.equal(String(url), ORIGIN + "/v2/chat/completions");
    assert.equal(options.redirect, "error");
    assert.equal(options.headers.get("Content-Encoding"), "gzip");
    assert.equal(options.headers.get("X-Private-Data"), "true");
    assert.equal(options.headers.get("X-Conversation-ID"), "session-id");
    assert.equal(JSON.parse(gunzipSync(options.body)).model, "hy3");
    return new Response('data: [DONE]\n\n', { headers: { "Content-Type": "text/event-stream" } });
  } });
  const response = await fetch(ORIGIN + "/v2/chat/completions", { method: "POST", body: '{"model":"hy3"}' });
  assert.match(await response.text(), /DONE/);
  for (const url of ["https://evil.example/v2/chat/completions", ORIGIN + "/v2/other", ORIGIN + "/v2/chat/completions?key=s"]) {
    await assert.rejects(fetch(url, { method: "POST", body: "{}" }), /untrusted endpoint/);
  }
  assert.equal(calls, 1);
});

test("chat errors sanitize secrets and preserve retry/overflow classifications", async () => {
  for (const [status, code] of [[429, 12003], [400, "context_length_exceeded"]]) {
    const f = createChatFetch({ fetch: async () => new Response(JSON.stringify({ error: { code, message: "SECRET" } }), {
      status, headers: { "Retry-After": "2" },
    }) });
    const response = await f(ORIGIN + "/v2/chat/completions", { method: "POST", body: "{}" });
    assert.equal(response.status, status);
    assert.equal(response.headers.get("retry-after"), "2");
    const body = await response.text();
    assert.ok(!body.includes("SECRET"));
    if (status === 400) assert.match(body, /context_length_exceeded/);
  }
});

test("status is local and refresh requires configured login", async () => {
  let command;
  const notices = [];
  registerNativeCommands({ registerCommand: (_name, config) => { command = config; } }, { getModels: () => [{ id: "default-model" }] });
  const ctx = { modelRegistry: { hasConfiguredAuth: () => false }, ui: { notify: (...args) => notices.push(args) } };
  await command.handler("status", ctx);
  await command.handler("refresh", ctx);
  assert.match(notices[0][0], /not logged in/);
  assert.match(notices[1][0], /Sign in/);
});
