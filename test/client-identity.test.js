import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { EXTENSION_VERSION, WORKBUDDY_PROTOCOL_VERSION, USER_AGENT } from "../src/client-identity.js";
import { createNativeClient, accountHeaders, ORIGIN } from "../src/native-client.js";
import { createChatFetch } from "../src/native-transport.js";
import { WorkbuddyError, describeFailure } from "../src/native-errors.js";

const credential = () => ({ type: "oauth", origin: ORIGIN, access: "SYNTHETIC_ACCESS", refresh: "SYNTHETIC_REFRESH",
  expires: Date.now() + 3600000, userId: "mock-user" });
const json = data => new Response(JSON.stringify({ code: 0, data }));

test("version marker is ASCII-safe and retains the extension's own identity", () => {
  assert.equal(EXTENSION_VERSION, JSON.parse(readFileSync(new URL("../package.json", import.meta.url))).version);
  assert.equal(WORKBUDDY_PROTOCOL_VERSION, "5.8.4");
  assert.match(USER_AGENT, /WorkBuddy\/\d+\.\d+\.\d+/);
  assert.ok(USER_AGENT.includes("pi-workbuddy/" + EXTENSION_VERSION));
  assert.doesNotMatch(USER_AGENT, /[^\x20-\x7e]/);
  assert.equal(accountHeaders(credential())["User-Agent"], USER_AGENT);
});

test("login, token polling, account lookup, refresh, and discovery share the version-aware User-Agent", async () => {
  const seen = [];
  const client = createNativeClient({ fetch: async (url, options) => {
    assert.equal(options.headers["User-Agent"], USER_AGENT);
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

test("discovery does not regress to the User-Agent that triggers server business error 12403", async () => {
  const client = createNativeClient({ fetch: async (_url, options) => {
    if (!options.headers["User-Agent"]?.includes("WorkBuddy/")) {
      return new Response('{"code":12403,"msg":"check ua, get coding copilot version error"}', { status: 400 });
    }
    return json({ models: [{ id: "default-model" }] });
  } });
  assert.equal((await client.catalog(credential())).models[0].id, "default-model");
});

test("chat transport pins the compatible version marker over the SDK's default User-Agent", async () => {
  const fetch = createChatFetch({ fetch: async (_url, options) => {
    assert.equal(options.headers.get("User-Agent"), USER_AGENT);
    assert.equal(options.headers.get("X-IDE-Version"), EXTENSION_VERSION);
    assert.equal(options.headers.get("X-IDE-Name"), "pi-workbuddy");
    return new Response("data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } });
  } });
  const response = await fetch(ORIGIN + "/v2/chat/completions", {
    method: "POST", headers: { "User-Agent": "pi-sdk-default" }, body: "{}",
  });
  await response.text();
});

test("12403 diagnostics explain the version header without exposing the server body", () => {
  const text = describeFailure(new WorkbuddyError("http", "SECRET_BODY", { status: 400, businessCode: 12403 }));
  assert.match(text, /User-Agent/);
  assert.match(text, /12403/);
  assert.doesNotMatch(text, /SECRET_BODY/);
});
