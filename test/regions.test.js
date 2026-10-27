import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { INTL_REGION, CN_REGION } from "../src/regions.js";
import { accountHeaders, createNativeClient, ORIGIN, BASE_URL } from "../src/native-client.js";
import { projectModels, fallbackModels } from "../src/native-models.js";
import { catalogCacheKey, catalogCacheEntry, restoreCatalog } from "../src/native-catalog-cache.js";
import { createChatFetch } from "../src/native-transport.js";
import { createWorkbuddyProvider } from "../src/native-provider.js";
import { registerWorkbuddy, registerWorkbuddyProviders } from "../src/extension.js";

const regions = [INTL_REGION, CN_REGION];
const otherRegion = region => region === INTL_REGION ? CN_REGION : INTL_REGION;
// Accept either arrays or Sets so the profile shape can stay an implementation detail.
const members = value => Array.isArray(value) ? value : [...value];
const credential = (region, extra = {}) => ({
  type: "oauth", origin: region.origin, domain: region.domain, userId: "same-synthetic-user",
  access: "SYNTHETIC_" + region.id, refresh: "SYNTHETIC_REFRESH_" + region.id,
  expires: Date.now() + 3600000, ...extra,
});
const json = data => new Response(JSON.stringify({ code: 0, data }), { headers: { "Content-Type": "application/json" } });
const noInference = { stream() { throw new Error("Inference prohibited"); }, streamSimple() { throw new Error("Inference prohibited"); } };
const config = { models: [{ id: "shared-model", name: "Shared model", supportsToolCall: true }] };
// Account identity wins over any client-profile key with the same name.
const ACCOUNT_HEADERS = new Set(["authorization", "x-user-id", "x-domain", "x-product",
  "x-requested-with", "x-enterprise-id", "x-tenant-id", "content-type"]);
// Both official protocols use <baseUrl>/chat/completions; the transport enforces it.
const chatUrl = region => region.baseUrl + "/chat/completions";

function assertClientProfile(headers, region) {
  const other = otherRegion(region);
  for (const [key, value] of Object.entries(region.clientHeaders)) {
    if (!ACCOUNT_HEADERS.has(key.toLowerCase())) assert.equal(headers[key], value, region.id + " " + key);
  }
  // Distinguishing identity values must never come from the other region.
  for (const key of ["User-Agent", "X-IDE-Version"]) {
    if (other.clientHeaders[key] === region.clientHeaders[key]) continue;
    assert.notEqual(headers[key], other.clientHeaders[key], region.id + " leaked " + key);
  }
}

// These assertions use the official profiles, not guessed CN header/platform values.
test("official CN profile pins only production hosts, domains, and its own client identity", () => {
  assert.equal(CN_REGION.origin, "https://www.workbuddy.cn");
  assert.equal(CN_REGION.baseUrl, "https://www.workbuddy.cn/v2");
  assert.equal(CN_REGION.domain, "www.workbuddy.cn");
  assert.equal(CN_REGION.platform, "workbuddy");
  assert.equal(CN_REGION.loginAccountPath, "/v2/plugin/account");
  assert.equal(CN_REGION.loginAccountUsesState, false);
  assert.equal(INTL_REGION.loginAccountPath, "/v2/plugin/login/account");
  assert.equal(INTL_REGION.loginAccountUsesState, true);
  assert.deepEqual(members(CN_REGION.accountDomains).slice().sort(),
    ["copilot.tencent.com", "www.codebuddy.cn", "www.workbuddy.cn"]);
  assert.deepEqual(members(CN_REGION.browserOrigins).slice().sort(),
    ["https://copilot.tencent.com", "https://www.codebuddy.cn", "https://www.workbuddy.cn"]);
  for (const value of [...members(CN_REGION.accountDomains), ...members(CN_REGION.browserOrigins)]) {
    assert.doesNotMatch(value, /staging|test|dev|localhost|\*|workbuddy\.ai|codebuddy\.ai/i);
  }
  assert.equal(CN_REGION.clientHeaders["X-IDE-Version"], "5.8.3");
  assert.equal(CN_REGION.clientHeaders["User-Agent"], "WorkBuddy/5.8.3 WorkBuddy/5.8.3 CLI/2.161.0");
  assert.equal(CN_REGION.clientHeaders["X-IDE-Type"], "WorkBuddy");
  assert.equal(CN_REGION.clientHeaders["X-IDE-Name"], "WorkBuddy");
  assert.equal(INTL_REGION.clientHeaders["X-IDE-Version"], "5.8.4");
  assert.notEqual(CN_REGION.clientHeaders["User-Agent"], INTL_REGION.clientHeaders["User-Agent"]);
  assert.notEqual(CN_REGION.fallbackName, INTL_REGION.fallbackName);
  // Nested profile data must be immutable too, so one region cannot be mutated at runtime.
  for (const region of regions) {
    assert.equal(Object.isFrozen(region.browserOrigins), true, region.id + " browserOrigins");
    assert.equal(Object.isFrozen(region.accountDomains), true, region.id + " accountDomains");
    assert.equal(Object.isFrozen(region.clientHeaders), true, region.id + " clientHeaders");
    assert.throws(() => { region.browserOrigins.push("https://attacker.example"); }, TypeError);
    assert.throws(() => { region.accountDomains.push("attacker.example"); }, TypeError);
    assert.throws(() => { region.clientHeaders["X-Domain"] = "attacker.example"; }, TypeError);
    assert.throws(() => { region.origin = "https://attacker.example"; }, TypeError);
  }
});

test("region profiles are immutable, distinct, and keep international constants compatible", () => {
  assert.equal(INTL_REGION.id, "workbuddy");
  assert.equal(CN_REGION.id, "workbuddy-cn");
  assert.equal(INTL_REGION.origin, ORIGIN);
  assert.equal(INTL_REGION.baseUrl, BASE_URL);
  assert.notEqual(INTL_REGION.origin, CN_REGION.origin);
  assert.notEqual(INTL_REGION.domain, CN_REGION.domain);
  for (const region of regions) {
    assert.equal(Object.isFrozen(region), true);
    assert.equal(new URL(region.origin).protocol, "https:");
    assert.equal(new URL(region.baseUrl).origin, region.origin);
    assert.ok(members(region.accountDomains).includes(region.domain));
    assert.ok(members(region.browserOrigins).length > 0);
    assert.equal(typeof region.name, "string");
    assert.ok(region.name.length > 0);
    assert.equal(typeof region.platform, "string");
    assert.ok(region.platform.length > 0);
    assert.equal(typeof region.fallbackName, "string");
    assert.ok(region.fallbackName.length > 0);
    assert.ok(Object.keys(region.clientHeaders).length > 0);
  }
});

test("projection and fallback stay local to their region; the omitted region remains international", () => {
  assert.deepEqual(projectModels(config), projectModels(config, INTL_REGION));
  assert.deepEqual(fallbackModels(), fallbackModels(INTL_REGION));
  for (const region of regions) {
    const projected = projectModels({ models: [
      { ...config.models[0], provider: otherRegion(region).id, baseUrl: otherRegion(region).baseUrl,
        headers: { Authorization: "PRIVATE" }, prompts: ["PRIVATE"] },
      { id: "remote-endpoint", url: otherRegion(region).baseUrl },
    ] }, region);
    assert.equal(projected.length, 1);
    assert.equal(projected[0].provider, region.id);
    assert.equal(projected[0].baseUrl, region.baseUrl);
    assert.doesNotMatch(JSON.stringify(projected), /PRIVATE|prompts|remote-endpoint/);
    const fallback = fallbackModels(region);
    assert.equal(fallback[0].provider, region.id);
    assert.equal(fallback[0].baseUrl, region.baseUrl);
    assert.equal(fallback[0].name, region.fallbackName);
    const withSg = projectModels({ models: [{ id: "shared-model" }, { id: "deepseek-synthetic-sg" }] }, region);
    assert.equal(withSg.some(model => model.id === "deepseek-synthetic-sg"), !region.excludeSg);
  }
});

test("account headers reject the other region's origin and domain before any request", async () => {
  for (const region of regions) {
    const headers = accountHeaders(credential(region), region);
    assert.equal(headers.Authorization, "Bearer SYNTHETIC_" + region.id);
    assert.equal(headers["X-User-Id"], "same-synthetic-user");
    assert.equal(headers["X-Domain"], region.domain);
    assert.equal(accountHeaders(credential(region, { domain: undefined }), region)["X-Domain"], region.domain);
    assertClientProfile(headers, region);
    // Every official account domain of the region is accepted; no other region's is.
    for (const domain of members(region.accountDomains)) {
      const alternate = accountHeaders(credential(region, { domain }), region);
      assert.equal(alternate["X-Domain"], domain);
      assertClientProfile(alternate, region);
    }
    assert.throws(() => accountHeaders(credential(otherRegion(region)), region), /different endpoint/);
    assert.throws(() => accountHeaders(credential(region, { domain: otherRegion(region).domain }), region), /domain/);
    let requests = 0;
    const client = createNativeClient({ region, fetch: async () => { requests++; throw new Error("Unexpected request"); } });
    for (const invalid of [credential(otherRegion(region)), credential(region, { domain: otherRegion(region).domain })]) {
      await assert.rejects(client.refresh(invalid));
      await assert.rejects(client.catalog(invalid));
    }
    assert.equal(requests, 0);
  }
});

test("each native login, refresh and catalog uses only its regional host and profile", async () => {
  for (const region of regions) {
    const requests = [], notices = [], seen = { state: 0, token: 0, account: 0, refresh: 0, catalog: 0 };
    const authOrigin = members(region.browserOrigins)[0];
    const client = createNativeClient({ region, pollIntervalMs: 1, fetch: async (input, init) => {
      const url = new URL(input);
      requests.push({ url, ...init });
      assert.equal(url.origin, region.origin);
      assert.equal(init.redirect, "error");
      assert.equal(init.headers["X-Domain"], region.domain);
      assertClientProfile(init.headers, region);
      // Classify by protocol role, not path: the CN protocol may use different paths.
      if (init.headers["X-Refresh-Token"] !== undefined) {
        seen.refresh++;
        assert.equal(init.headers["X-Refresh-Token"], "SYNTHETIC_REFRESH");
        return json({ accessToken: "ROTATED_TOKEN", refreshToken: "ROTATED_REFRESH", expiresIn: 3600, domain: region.domain });
      }
      if (init.headers.Authorization === "Bearer SYNTHETIC_TOKEN") {
        seen.account++;
        assert.equal(url.pathname, region.loginAccountPath);
        assert.equal(url.searchParams.has("state"), region.loginAccountUsesState);
        return json({ uid: "same-synthetic-user" });
      }
      if (init.headers.Authorization === "Bearer ROTATED_TOKEN") {
        seen.catalog++;
        return json(config);
      }
      if (init.method === "POST") {
        seen.state++;
        return json({ state: "synthetic-state", authUrl: authOrigin + "/login?state=synthetic-state" });
      }
      seen.token++;
      return json({ accessToken: "SYNTHETIC_TOKEN", refreshToken: "SYNTHETIC_REFRESH", expiresIn: 3600, domain: region.domain });
    } });
    const loggedIn = await client.login({ notify: event => notices.push(event) });
    assert.equal(loggedIn.origin, region.origin);
    assert.equal(loggedIn.domain, region.domain);
    assert.equal(loggedIn.access, "SYNTHETIC_TOKEN");
    assert.equal(notices.find(event => event.type === "auth_url").url, authOrigin + "/login?state=synthetic-state");
    const stateRequest = requests.find(request => request.url.searchParams.has("platform"));
    assert.ok(stateRequest, "login state request carries the regional platform");
    assert.equal(stateRequest.url.searchParams.get("platform"), region.platform);
    const refreshed = await client.refresh(loggedIn);
    assert.equal(refreshed.origin, region.origin);
    assert.equal(refreshed.access, "ROTATED_TOKEN");
    assert.deepEqual(await client.catalog(refreshed), config);
    // Account lookup is optional per protocol; the other roles are required and never duplicated.
    assert.equal(seen.state, 1);
    assert.equal(seen.token, 1);
    assert.ok(seen.account <= 1);
    assert.equal(seen.refresh, 1);
    assert.equal(seen.catalog, 1);
    assert.ok(requests.length >= 5);
    assert.deepEqual(requests.map(request => request.url.origin), Array(requests.length).fill(region.origin));
  }
});

test("regional login rejects cross-region browser URLs before polling or publishing them", async () => {
  for (const region of regions) {
    const allowed = new Set(members(region.browserOrigins));
    const foreignOrigins = [...members(otherRegion(region).browserOrigins), "https://attacker.example"]
      .filter(origin => !allowed.has(origin));
    assert.ok(foreignOrigins.includes("https://attacker.example"));
    for (const origin of foreignOrigins) {
      let requests = 0;
      const events = [];
      const client = createNativeClient({ region, fetch: async () => {
        requests++;
        return json({ state: "synthetic-state", authUrl: origin + "/login" });
      } });
      await assert.rejects(client.login({ notify: event => events.push(event) }), /untrusted login URL/);
      assert.equal(requests, 1);
      assert.equal(events.some(event => event.type === "auth_url"), false);
    }
  }
});

test("regional login and refresh reject tokens carrying the other account domain", async () => {
  for (const region of regions) {
    let requests = 0, stateRequests = 0, tokenRequests = 0, refreshRequests = 0;
    const client = createNativeClient({ region, fetch: async (_input, init) => {
      requests++;
      if (init.headers["X-Refresh-Token"] !== undefined) {
        refreshRequests++;
      } else if (init.method === "POST" && !init.headers.Authorization) {
        stateRequests++;
        return json({ state: "synthetic-state", authUrl: members(region.browserOrigins)[0] + "/login" });
      } else {
        tokenRequests++;
      }
      return json({ accessToken: "SYNTHETIC_TOKEN", refreshToken: "SYNTHETIC_REFRESH", expiresIn: 3600,
        domain: otherRegion(region).domain });
    } });
    await assert.rejects(client.login({ notify() {} }), /domain/);
    assert.equal(stateRequests, 1);
    assert.equal(tokenRequests, 1);
    assert.equal(requests, 2, "account lookup must not receive an invalid token");
    await assert.rejects(client.refresh(credential(region)), /domain/);
    assert.equal(refreshRequests, 1);
    assert.equal(requests, 3);
  }
});

test("the server-issued token domain wins inside the region and is carried into auth headers", async () => {
  for (const region of regions) {
    const alternate = members(region.accountDomains).find(value => value !== region.domain);
    let tokenCalls = 0;
    const client = createNativeClient({ region, fetch: async (_input, init) => {
      if (init.method === "POST" && !init.headers.Authorization && init.headers["X-Refresh-Token"] === undefined) {
        return json({ state: "synthetic-state", authUrl: members(region.browserOrigins)[0] + "/login" });
      }
      if (init.headers.Authorization?.startsWith("Bearer SYNTHETIC_TOKEN")) {
        assert.equal(init.headers["X-Domain"], alternate, "account lookup must use the token's account domain");
        return json({ uid: "same-synthetic-user" });
      }
      tokenCalls++;
      return json({ accessToken: "SYNTHETIC_TOKEN", refreshToken: "SYNTHETIC_REFRESH", expiresIn: 3600, domain: alternate });
    } });
    const credential = await client.login({ notify() {} });
    assert.equal(credential.origin, region.origin);
    assert.equal(credential.domain, alternate, region.id + " must prefer the server-issued domain");
    assert.equal(accountHeaders(credential, region)["X-Domain"], alternate);
    assert.equal(tokenCalls, 1);
  }
});

test("same-UID regional catalog keys never overlap and preserve the exact international v1 key", () => {
  const intl = credential(INTL_REGION, { domain: undefined, enterpriseId: "same-synthetic-tenant" });
  const cn = credential(CN_REGION, { enterpriseId: "same-synthetic-tenant" });
  const legacy = "workbuddy-catalog-v1:" + createHash("sha256").update(JSON.stringify([
    "https://www.workbuddy.ai", "same-synthetic-user", "www.workbuddy.ai", "same-synthetic-tenant",
  ])).digest("hex");
  assert.equal(catalogCacheKey(intl), legacy);
  assert.equal(catalogCacheKey(intl, INTL_REGION), legacy);
  const cnKey = catalogCacheKey(cn, CN_REGION);
  assert.equal(typeof cnKey, "string");
  assert.notEqual(cnKey, legacy);
  assert.equal(catalogCacheKey(intl, CN_REGION), undefined);
  assert.equal(catalogCacheKey(cn, INTL_REGION), undefined);
  assert.equal(catalogCacheKey({ ...cn, access: "ROTATED", refresh: "ROTATED_REFRESH" }, CN_REGION), cnKey);
  // Alternate official CN account domains stay inside the CN namespace only.
  const cnAlternate = catalogCacheKey({ ...cn, domain: "www.codebuddy.cn" }, CN_REGION);
  assert.equal(typeof cnAlternate, "string");
  assert.notEqual(cnAlternate, cnKey);
  assert.notEqual(cnAlternate, legacy);
  assert.equal(catalogCacheKey({ ...intl, domain: "www.codebuddy.cn" }, INTL_REGION), undefined);
  assert.doesNotMatch(cnKey, /same-synthetic-user|same-synthetic-tenant|SYNTHETIC/);
});

test("cached metadata cannot restore a foreign region, even under a forged matching etag", () => {
  for (const region of regions) {
    const other = otherRegion(region);
    const key = catalogCacheKey(credential(region), region);
    const foreign = catalogCacheEntry(projectModels(config, other), catalogCacheKey(credential(other), other));
    assert.equal(restoreCatalog(foreign, key, region), undefined);
    // A forged matching etag must still never yield foreign providers/endpoints.
    let forged;
    try { forged = restoreCatalog({ ...foreign, etag: key }, key, region); }
    catch (error) { assert.equal(error.diagnosticCode, "catalog-cache"); }
    if (forged) assert.ok(forged.every(model => model.provider === region.id && model.baseUrl === region.baseUrl));
    const local = projectModels(config, region)[0];
    const stored = catalogCacheEntry([
      { ...local, headers: { Authorization: "PRIVATE" }, prompts: ["PRIVATE"] },
      { ...local, id: "foreign-provider", provider: other.id },
      { ...local, id: "foreign-endpoint", baseUrl: other.baseUrl },
    ], key);
    const restored = restoreCatalog(stored, key, region);
    assert.deepEqual(restored.map(model => model.id), ["shared-model"]);
    assert.equal(restored[0].provider, region.id);
    assert.equal(restored[0].baseUrl, region.baseUrl);
    assert.doesNotMatch(JSON.stringify(restored), /PRIVATE|foreign-provider|foreign-endpoint|prompts/);
  }
});

test("regional chat transports reject cross-region endpoints before forwarding credentials", async () => {
  for (const region of regions) {
    const other = otherRegion(region);
    const accepted = chatUrl(region);
    let requests = 0;
    const transport = createChatFetch({ region, gzip: false, fetch: async (input, init) => {
      requests++;
      assert.equal(String(input), accepted);
      assert.equal(init.redirect, "error");
      assert.equal(init.headers.get("Authorization"), "Bearer SYNTHETIC_" + region.id);
      for (const [key, value] of Object.entries(region.clientHeaders)) {
        if (!ACCOUNT_HEADERS.has(key.toLowerCase())) assert.equal(init.headers.get(key), value, region.id + " " + key);
      }
      return new Response("data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } });
    } });
    const init = { method: "POST", headers: accountHeaders(credential(region), region), body: "{}" };
    await (await transport(accepted, init)).text();
    const samePath = new URL(accepted).pathname;
    for (const endpoint of [other.baseUrl + "/chat/completions", other.baseUrl + samePath,
      region.baseUrl + "/untrusted-route", accepted + "?secret=synthetic", "https://attacker.example/v2/chat/completions"]) {
      await assert.rejects(transport(endpoint, init), /untrusted endpoint/, endpoint);
    }
    assert.equal(requests, 1);
  }
});

test("chat transport rejects the regional endpoint when X-Domain belongs to the other region", async () => {
  for (const region of regions) {
    const other = otherRegion(region);
    const accepted = chatUrl(region);
    let requests = 0;
    const transport = createChatFetch({ region, gzip: false, fetch: async () => { requests++; throw new Error("Must not send"); } });
    const local = members(region.accountDomains);
    const foreignDomains = [...members(other.accountDomains), other.domain, "attacker.example"]
      .filter(value => !local.includes(value));
    for (const domain of foreignDomains) {
      const headers = { ...accountHeaders(credential(region), region), "X-Domain": domain };
      await assert.rejects(transport(accepted, { method: "POST", headers, body: "{}" }),
        /different account domain/);
    }
    assert.equal(requests, 0);
  }
});

test("providers pin models and auth to their region, ignoring foreign model endpoints", async () => {
  for (const region of regions) {
    let sent;
    const provider = createWorkbuddyProvider({ region, api: {
      stream(...args) { sent = args; }, streamSimple(...args) { sent = args; },
    } });
    assert.equal(provider.id, region.id);
    assert.equal(provider.baseUrl, region.baseUrl);
    assert.equal(provider.getModels()[0].provider, region.id);
    const auth = await provider.auth.oauth.toAuth(credential(region));
    assert.equal(auth.baseUrl, region.baseUrl);
    assert.equal(auth.headers["X-Domain"], region.domain);
    await assert.rejects(provider.auth.oauth.toAuth(credential(otherRegion(region))));
    provider.streamSimple({ ...provider.getModels()[0], baseUrl: otherRegion(region).baseUrl }, {}, {});
    assert.equal(sent[0].baseUrl, region.baseUrl);
    const samePath = new URL(chatUrl(region)).pathname;
    for (const endpoint of [otherRegion(region).baseUrl + "/chat/completions",
      otherRegion(region).baseUrl + samePath]) {
      await assert.rejects(sent[2].fetch(endpoint, { method: "POST", body: "{}" }), /untrusted endpoint/);
    }
  }
});

test("dual registration shares one hook pair and keeps the legacy single-provider entry point", () => {
  function harness() {
    const providers = [], commands = [], hooks = [];
    return { providers, commands, hooks, pi: {
      registerProvider: provider => providers.push(provider),
      registerCommand: (name, config) => commands.push([name, config]),
      on: (name, handler) => hooks.push([name, handler]),
    } };
  }
  const dual = harness();
  const registered = registerWorkbuddyProviders(dual.pi, { api: noInference });
  assert.deepEqual(registered.map(provider => provider.id), ["workbuddy", "workbuddy-cn"]);
  assert.deepEqual(dual.providers, registered);
  assert.deepEqual(dual.commands.map(([name]) => name), ["workbuddy", "workbuddy-cn"]);
  assert.deepEqual(dual.hooks.map(([name]) => name), ["session_start", "session_shutdown"]);
  const legacy = harness();
  const provider = registerWorkbuddy(legacy.pi, { api: noInference });
  assert.equal(provider.id, "workbuddy");
  assert.equal(provider.baseUrl, INTL_REGION.baseUrl);
  assert.deepEqual(legacy.providers, [provider]);
  assert.deepEqual(legacy.commands.map(([name]) => name), ["workbuddy"]);
  assert.deepEqual(legacy.hooks.map(([name]) => name), ["session_start", "session_shutdown"]);
});
