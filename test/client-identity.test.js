import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { gunzipSync } from "node:zlib";
import {
  CLIENT_HEADERS, EXTENSION_VERSION, WORKBUDDY_PROTOCOL_VERSION,
  WORKBUDDY_CLI_VERSION, USER_AGENT,
} from "../src/client-identity.js";
import { createNativeClient, accountHeaders, ORIGIN } from "../src/native-client.js";
import { createChatFetch } from "../src/native-transport.js";
import { WorkbuddyError, describeFailure } from "../src/native-errors.js";

const credential = () => ({ type: "oauth", origin: ORIGIN, access: "SYNTHETIC_ACCESS", refresh: "SYNTHETIC_REFRESH",
  expires: Date.now() + 3600000, userId: "mock-user" });
const json = data => new Response(JSON.stringify({ code: 0, data }));
const done = () => new Response("data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } });

function assertClientIdentity(value) {
  const headers = new Headers(value);
  for (const [key, expected] of Object.entries(CLIENT_HEADERS)) assert.equal(headers.get(key), expected, key);
  assert.equal(headers.get("X-IDE-Type"), "WorkBuddy");
  assert.equal(headers.get("X-IDE-Name"), "WorkBuddy");
  assert.equal(headers.get("X-IDE-Version"), WORKBUDDY_PROTOCOL_VERSION);
  assert.notEqual(headers.get("X-IDE-Version"), EXTENSION_VERSION);
  assert.doesNotMatch(JSON.stringify([...headers]), /pi-workbuddy|pi-sdk-default|CLI\/unknown/i);
}

test("local package version is independent of the pinned official desktop wire identity", () => {
  assert.equal(EXTENSION_VERSION, JSON.parse(readFileSync(new URL("../package.json", import.meta.url))).version);
  assert.equal(WORKBUDDY_PROTOCOL_VERSION, "5.8.4");
  assert.equal(WORKBUDDY_CLI_VERSION, "2.161.0");
  assert.equal(USER_AGENT, "WorkBuddy/5.8.4 WorkBuddy/5.8.4 CLI/2.161.0");
  assert.doesNotMatch(USER_AGENT, /[^\x20-\x7e]/);
  assert.ok(Object.isFrozen(CLIENT_HEADERS));
  assertClientIdentity(CLIENT_HEADERS);
});

test("account headers retain real account metadata while sharing the official client profile", () => {
  const headers = accountHeaders({ ...credential(), enterpriseId: "synthetic-enterprise" });
  assertClientIdentity(headers);
  assert.equal(headers.Authorization, "Bearer SYNTHETIC_ACCESS");
  assert.equal(headers["X-User-Id"], "mock-user");
  assert.equal(headers["X-Domain"], "www.workbuddy.ai");
  assert.equal(headers["X-Enterprise-Id"], "synthetic-enterprise");
  assert.equal(headers["X-Tenant-Id"], "synthetic-enterprise");
});

test("login, polling, account lookup, token refresh and catalog all use the same non-Pi client profile", async () => {
  const seen = [];
  const client = createNativeClient({ fetch: async (url, options) => {
    assertClientIdentity(options.headers);
    const path = new URL(url).pathname;
    seen.push(path);
    if (path.endsWith("/auth/state")) return json({ state: "synthetic", authUrl: ORIGIN + "/login" });
    if (path.endsWith("/login/account")) return json({ uid: "mock-user" });
    if (path === "/v3/config") return json({ models: [{ id: "default-model" }] });
    return json({ accessToken: "SYNTHETIC_ACCESS", refreshToken: "SYNTHETIC_REFRESH", expiresIn: 3600 });
  } });
  const loggedIn = await client.login({ notify() {} });
  await client.refresh(loggedIn);
  const catalog = await client.catalog(loggedIn);
  assert.equal(catalog.models.length, 1);
  assert.deepEqual(seen, ["/v2/plugin/auth/state", "/v2/plugin/auth/token", "/v2/plugin/login/account", "/v2/plugin/auth/token/refresh", "/v3/config"]);
});

test("discovery retains the version-aware UA needed to avoid simulated business error 12403", async () => {
  const client = createNativeClient({ fetch: async (_url, options) => {
    if (!options.headers["User-Agent"]?.includes("WorkBuddy/")) {
      return new Response('{"code":12403,"msg":"check ua, get coding copilot version error"}', { status: 400 });
    }
    return json({ models: [{ id: "default-model" }] });
  } });
  assert.equal((await client.catalog(credential())).models[0].id, "default-model");
});

test("scoped chat fetch overwrites SDK/Pi identity fields case-insensitively", async () => {
  const fetch = createChatFetch({ fetch: async (_url, options) => {
    assertClientIdentity(options.headers);
    return done();
  } });
  const response = await fetch(ORIGIN + "/v2/chat/completions", {
    method: "POST", headers: {
      "user-agent": "pi-sdk-default",
      "x-ide-type": "pi",
      "X-IDE-Name": "pi-workbuddy",
      "x-IDE-version": "0.1.0",
    }, body: "{}",
  });
  await response.text();
});

test("client-header correction does not rewrite prompts, tools, or account identity in either transport mode", async () => {
  const body = { model: "synthetic-model", stream: true,
    messages: [{ role: "system", content: "Keep the original system prompt." }, { role: "user", content: "Keep this task." }],
    tools: [{ type: "function", function: { name: "read", parameters: { type: "object" } } }],
  };
  for (const gzip of [true, false]) {
    const fetch = createChatFetch({ gzip, fetch: async (_url, options) => {
      assertClientIdentity(options.headers);
      assert.equal(options.headers.get("Authorization"), "Bearer SYNTHETIC_ACCESS");
      assert.equal(options.headers.get("X-User-Id"), "mock-user");
      assert.equal(options.headers.get("Content-Encoding"), gzip ? "gzip" : null);
      assert.deepEqual(JSON.parse(gzip ? gunzipSync(options.body) : options.body), body);
      return done();
    } });
    await (await fetch(ORIGIN + "/v2/chat/completions", {
      method: "POST", headers: accountHeaders(credential()), body: JSON.stringify(body),
    })).text();
  }
});

test("session correlation and fresh request IDs remain unchanged by the client profile fix", async () => {
  const ids = [];
  const fetch = createChatFetch({ sessionId: "synthetic-session", fetch: async (_url, options) => {
    assertClientIdentity(options.headers);
    assert.equal(options.headers.get("X-Conversation-ID"), "synthetic-session");
    const id = options.headers.get("X-Request-ID");
    assert.equal(id, options.headers.get("X-Conversation-Message-ID"));
    assert.equal(id, options.headers.get("X-Conversation-Request-ID"));
    ids.push(id);
    return done();
  } });
  for (let call = 0; call < 2; call++) await (await fetch(ORIGIN + "/v2/chat/completions", { method: "POST", body: "{}" })).text();
  assert.notEqual(ids[0], ids[1]);
});

test("12403 diagnostics retain the official version error", () => {
  const text = describeFailure(new WorkbuddyError("http", "Cannot parse User-Agent version", { status: 400, businessCode: 12403 }));
  assert.match(text, /Cannot parse User-Agent version/);
  assert.match(text, /12403/);
});
