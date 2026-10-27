import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import { INTL_REGION, CN_REGION } from "../src/regions.js";
import { createNativeClient } from "../src/native-client.js";
import { createWorkbuddyProvider } from "../src/native-provider.js";
import { catalogCacheKey } from "../src/native-catalog-cache.js";

// Optional real Pi integration; only in-memory stores and synthetic fetch responses.
const dist = process.env.PI_AI_TEST_PATH;
const hostTest = (name, fn) => test(name, {
  skip: !dist && "Set PI_AI_TEST_PATH to the installed pi-ai/dist directory", timeout: 10000,
}, fn);
const regions = [INTL_REGION, CN_REGION];
const otherRegion = region => regions.find(value => value !== region);
const members = value => Array.isArray(value) ? value : [...value];
const credential = region => ({
  type: "oauth", origin: region.origin, domain: region.domain, userId: "same-synthetic-user",
  access: "SYNTHETIC_ACCESS_" + region.id, refresh: "SYNTHETIC_REFRESH_" + region.id, expires: Date.now() + 3600000,
});
const json = data => new Response(JSON.stringify({ code: 0, data }), { headers: { "Content-Type": "application/json" } });
const noInference = { stream() { throw new Error("Inference prohibited"); }, streamSimple() { throw new Error("Inference prohibited"); } };
const context = () => ({ messages: [{ role: "user", content: "Synthetic offline request", timestamp: Date.now() }] });
const ACCOUNT_HEADERS = new Set(["authorization", "x-user-id", "x-domain", "x-product",
  "x-requested-with", "x-enterprise-id", "x-tenant-id", "content-type"]);
function deferred() {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  return { promise, resolve };
}
async function loadHost() {
  const host = await import(pathToFileURL(join(dist, "index.js")).href);
  const api = await import(pathToFileURL(join(dist, "api/openai-completions.js")).href);
  return { host, api };
}
function sse(text) {
  const values = [
    { id: "synthetic-response", choices: [{ index: 0, delta: { content: text }, finish_reason: null }] },
    { id: "synthetic-response", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
  ];
  return new Response(values.map(value => "data: " + JSON.stringify(value) + "\n\n").join("") + "data: [DONE]\n\n", {
    headers: { "Content-Type": "text/event-stream" },
  });
}

hostTest("Pi dual host: login persistence and refresh locks are independent even for the same user ID", async () => {
  const { host } = await loadHost();
  const credentials = new host.InMemoryCredentialStore();
  const models = host.createModels({ credentials });
  const gates = new Map(regions.map(region => [region.id, deferred()]));
  const started = new Map(regions.map(region => [region.id, deferred()]));
  const refreshes = new Map(regions.map(region => [region.id, 0]));
  for (const region of regions) {
    const client = createNativeClient({ region, fetch: async (input, init) => {
      const url = new URL(input);
      assert.equal(url.origin, region.origin);
      assert.equal(init.headers["X-Domain"], region.domain);
      for (const [key, value] of Object.entries(region.clientHeaders)) {
        if (!ACCOUNT_HEADERS.has(key.toLowerCase())) assert.equal(init.headers[key], value, region.id + " " + key);
      }
      if (url.pathname.endsWith("/auth/state")) return json({ state: "synthetic-state", authUrl: members(region.browserOrigins)[0] + "/login" });
      if (url.pathname === region.loginAccountPath) {
        assert.equal(url.searchParams.has("state"), region.loginAccountUsesState);
        return json({ uid: "same-synthetic-user" });
      }
      const refreshing = url.pathname.endsWith("/refresh");
      if (refreshing) {
        refreshes.set(region.id, refreshes.get(region.id) + 1);
        assert.equal(init.headers["X-Refresh-Token"], "SYNTHETIC_REFRESH_" + region.id);
        started.get(region.id).resolve();
        await gates.get(region.id).promise;
      }
      return json({ accessToken: (refreshing ? "ROTATED_" : "FIRST_") + region.id,
        refreshToken: "SYNTHETIC_REFRESH_" + region.id, expiresIn: 3600, domain: region.domain });
    } });
    models.setProvider(createWorkbuddyProvider({ region, api: noInference, client }));
  }
  await Promise.all(regions.map(region => models.login(region.id, "oauth", {
    notify() {}, prompt: async () => { throw new Error("Unexpected prompt"); },
  })));
  for (const region of regions) {
    const stored = await credentials.read(region.id);
    assert.equal(stored.origin, region.origin);
    assert.equal(stored.userId, "same-synthetic-user");
    assert.equal(stored.access, "FIRST_" + region.id);
    await credentials.modify(region.id, async current => ({ ...current, expires: Date.now() - 1000 }));
  }
  const pending = regions.flatMap(region => Array.from({ length: 3 }, () => models.getAuth(region.id)));
  await Promise.all([...started.values()].map(value => value.promise));
  assert.deepEqual([...refreshes.values()], [1, 1], "one region's credential lock must not block the other region");
  gates.get(CN_REGION.id).resolve();
  const cnAuth = await pending[3];
  assert.equal(cnAuth.auth.apiKey, "ROTATED_" + CN_REGION.id);
  assert.equal((await credentials.read(INTL_REGION.id)).access, "FIRST_" + INTL_REGION.id);
  gates.get(INTL_REGION.id).resolve();
  const results = await Promise.all(pending);
  for (const [index, region] of regions.entries()) {
    for (const auth of results.slice(index * 3, index * 3 + 3)) {
      assert.equal(auth.auth.apiKey, "ROTATED_" + region.id);
      assert.equal(auth.auth.headers["X-Domain"], region.domain);
      assert.equal(auth.auth.baseUrl, region.baseUrl);
    }
    assert.equal((await credentials.read(region.id)).access, "ROTATED_" + region.id);
  }
  assert.deepEqual([...refreshes.values()], [1, 1]);
  await models.logout(CN_REGION.id);
  assert.equal(await credentials.read(CN_REGION.id), undefined);
  assert.equal((await models.getAuth(INTL_REGION.id)).auth.apiKey, "ROTATED_" + INTL_REGION.id);
});

hostTest("Pi dual host: regional catalogs persist separately and foreign caches cannot be restored", async () => {
  const { host } = await loadHost();
  const credentials = new host.InMemoryCredentialStore();
  const modelsStore = new host.InMemoryModelsStore();
  const models = host.createModels({ credentials, modelsStore });
  const calls = new Map(regions.map(region => [region.id, 0]));
  for (const region of regions) {
    await credentials.modify(region.id, async () => credential(region));
    models.setProvider(createWorkbuddyProvider({ region, api: noInference, client: createNativeClient({ region,
      fetch: async (input, init) => {
        calls.set(region.id, calls.get(region.id) + 1);
        assert.equal(new URL(input).origin, region.origin);
        assert.equal(init.headers.Authorization, "Bearer SYNTHETIC_ACCESS_" + region.id);
        assert.equal(init.headers["X-Domain"], region.domain);
        return json({ models: [{ id: "shared-model", name: region.id + " shared" }, { id: region.id + "-only" }] });
      },
    }) }));
  }
  assert.equal((await models.refresh({ providers: [INTL_REGION.id], allowNetwork: true, force: true })).errors.size, 0);
  assert.deepEqual([...calls.values()], [1, 0]);
  assert.equal(models.getModels(CN_REGION.id)[0].name, CN_REGION.fallbackName);
  assert.equal((await models.refresh({ providers: [CN_REGION.id], allowNetwork: true, force: true })).errors.size, 0);
  assert.deepEqual([...calls.values()], [1, 1]);
  const entries = new Map();
  for (const region of regions) {
    const stored = await modelsStore.read(region.id);
    entries.set(region.id, stored);
    assert.equal(stored.etag, catalogCacheKey(credential(region), region));
    assert.ok(stored.models.every(model => model.provider === region.id && model.baseUrl === region.baseUrl));
    assert.doesNotMatch(JSON.stringify(stored), /SYNTHETIC_ACCESS|SYNTHETIC_REFRESH|same-synthetic-user/);
  }
  assert.notEqual(entries.get(INTL_REGION.id).etag, entries.get(CN_REGION.id).etag);
  const offline = host.createModels({ credentials, modelsStore });
  const providers = new Map();
  for (const region of regions) {
    const provider = createWorkbuddyProvider({ region, api: noInference,
      client: { async catalog() { throw new Error("Offline catalog must not make requests"); } } });
    providers.set(region.id, provider);
    offline.setProvider(provider);
  }
  assert.equal((await offline.refresh({ providers: regions.map(region => region.id), allowNetwork: false })).errors.size, 0);
  for (const region of regions) {
    assert.equal(providers.get(region.id).getCatalogStatus().source, "cache");
    assert.equal(offline.getModel(region.id, "shared-model").name, region.id + " shared");
    assert.equal(offline.getModel(region.id, otherRegion(region).id + "-only"), undefined);
  }
  for (const region of regions) {
    const foreign = entries.get(otherRegion(region).id);
    for (const stored of [foreign, { ...foreign, etag: entries.get(region.id).etag }]) {
      await modelsStore.write(region.id, stored);
      const fresh = createWorkbuddyProvider({ region, api: noInference });
      offline.setProvider(fresh);
      assert.equal((await offline.refresh({ providers: [region.id], allowNetwork: false })).errors.size, 0);
      assert.equal(fresh.getCatalogStatus().source, "fallback");
      assert.equal(fresh.getModels()[0].name, region.fallbackName);
      assert.ok(fresh.getModels().every(model => model.provider === region.id && model.baseUrl === region.baseUrl));
    }
    await modelsStore.write(region.id, entries.get(region.id));
  }
  assert.deepEqual([...calls.values()], [1, 1]);
});

hostTest("Pi dual host: inference pins regional hosts, tokens and headers and rejects misplaced credentials", async () => {
  const { host, api } = await loadHost();
  const credentials = new host.InMemoryCredentialStore();
  const models = host.createModels({ credentials });
  const requests = new Map(regions.map(region => [region.id, []]));
  const globalFetch = globalThis.fetch;
  for (const region of regions) {
    await credentials.modify(region.id, async () => credential(region));
    models.setProvider(createWorkbuddyProvider({ region, api, fetch: async (input, init) => {
      requests.get(region.id).push({ input, init });
      // The CN chat route is still under investigation; only the regional origin is contractual.
      assert.equal(new URL(input).origin, region.origin);
      assert.equal(new URL(input).origin === otherRegion(region).origin, false);
      assert.equal(init.redirect, "error");
      assert.equal(init.headers.get("Authorization"), "Bearer SYNTHETIC_ACCESS_" + region.id);
      assert.equal(init.headers.get("X-User-Id"), "same-synthetic-user");
      assert.equal(init.headers.get("X-Domain"), region.domain);
      assert.equal(init.headers.get("X-Conversation-ID"), "synthetic-session-" + region.id);
      for (const [key, value] of Object.entries(region.clientHeaders)) {
        if (!ACCOUNT_HEADERS.has(key.toLowerCase())) assert.equal(init.headers.get(key), value, region.id + " " + key);
      }
      assert.equal(JSON.parse(gunzipSync(init.body)).model, "default-model");
      return sse("Synthetic response from " + region.id);
    } }));
  }
  const results = await Promise.all(regions.map(region => models.completeSimple({
    ...models.getModels(region.id)[0], baseUrl: otherRegion(region).baseUrl,
  }, context(), { sessionId: "synthetic-session-" + region.id })));
  for (const [index, region] of regions.entries()) {
    assert.equal(results[index].stopReason, "stop", results[index].errorMessage);
    assert.equal(results[index].provider, region.id);
    assert.equal(results[index].content[0].text, "Synthetic response from " + region.id);
    assert.equal(requests.get(region.id).length, 1);
  }
  for (const invalid of [credential(INTL_REGION), { ...credential(CN_REGION), domain: INTL_REGION.domain }]) {
    await credentials.modify(CN_REGION.id, async () => invalid);
    const failed = await models.completeSimple(models.getModels(CN_REGION.id)[0], context());
    assert.equal(failed.stopReason, "error");
    assert.match(failed.errorMessage, /different endpoint|domain/);
    assert.equal(requests.get(CN_REGION.id).length, 1, "misplaced credentials must fail before transport");
    const unaffected = await models.completeSimple(models.getModels(INTL_REGION.id)[0], context(), {
      sessionId: "synthetic-session-" + INTL_REGION.id,
    });
    assert.equal(unaffected.stopReason, "stop", unaffected.errorMessage);
  }
  assert.equal(requests.get(INTL_REGION.id).length, 3);
  assert.equal(globalThis.fetch, globalFetch);
});

hostTest("Pi dual host: aborting one region's inference does not cancel the other region", async () => {
  const { host, api } = await loadHost();
  const credentials = new host.InMemoryCredentialStore();
  const models = host.createModels({ credentials });
  const intlStarted = deferred(), cnStarted = deferred(), cnRelease = deferred();
  let intlSignal, cnSignal;
  for (const region of regions) {
    await credentials.modify(region.id, async () => credential(region));
    models.setProvider(createWorkbuddyProvider({ region, api, fetch: async (_input, { signal }) => {
      if (region === INTL_REGION) {
        intlSignal = signal;
        intlStarted.resolve();
        await new Promise((_resolve, reject) => {
          if (signal.aborted) reject(signal.reason);
          else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      } else {
        cnSignal = signal;
        cnStarted.resolve();
        await cnRelease.promise;
        return sse("CN request survives international cancellation");
      }
    } }));
  }
  const controller = new AbortController();
  const intl = models.completeSimple(models.getModels(INTL_REGION.id)[0], context(), { signal: controller.signal });
  const cn = models.completeSimple(models.getModels(CN_REGION.id)[0], context());
  await Promise.all([intlStarted.promise, cnStarted.promise]);
  controller.abort();
  assert.equal((await intl).stopReason, "aborted");
  assert.equal(intlSignal.aborted, true);
  assert.equal(cnSignal.aborted, false);
  cnRelease.resolve();
  const result = await cn;
  assert.equal(result.stopReason, "stop", result.errorMessage);
  assert.equal(result.content[0].text, "CN request survives international cancellation");
});

hostTest("Pi dual host: reasoning capability and wire effort stay isolated per region", async () => {
  const { host, api } = await loadHost();
  const credentials = new host.InMemoryCredentialStore();
  const models = host.createModels({ credentials });
  const bodies = new Map(regions.map(region => [region.id, []]));
  const efforts = { [INTL_REGION.id]: ["low", "high", "max"], [CN_REGION.id]: ["low"] };
  for (const region of regions) {
    await credentials.modify(region.id, async () => credential(region));
    models.setProvider(createWorkbuddyProvider({ region, api,
      client: { async catalog(current) {
        assert.equal(current.origin, region.origin);
        return { models: [{ id: "shared-reasoning-model", supportsToolCall: true, supportsReasoning: true,
          reasoning: { supportedEfforts: efforts[region.id] } }] };
      } },
      fetch: async (input, init) => {
        assert.equal(new URL(input).origin, region.origin);
        bodies.get(region.id).push(JSON.parse(gunzipSync(init.body)));
        return sse("Synthetic reasoning from " + region.id);
      } }));
  }
  const refresh = await models.refresh({ providers: regions.map(region => region.id), allowNetwork: true, force: true });
  assert.equal(refresh.errors.size, 0);
  const projected = new Map(regions.map(region => [region.id, models.getModel(region.id, "shared-reasoning-model")]));
  assert.equal(projected.get(INTL_REGION.id).thinkingLevelMap.max, "max");
  assert.equal(projected.get(INTL_REGION.id).thinkingLevelMap.low, "low");
  assert.equal(projected.get(CN_REGION.id).thinkingLevelMap.max, null);
  assert.equal(projected.get(CN_REGION.id).thinkingLevelMap.low, "low");
  for (const region of regions) {
    const result = await models.completeSimple(projected.get(region.id), context(), { reasoning: "max" });
    assert.equal(result.stopReason, "stop", result.errorMessage);
    const body = bodies.get(region.id).at(-1);
    assert.equal(body.model, "shared-reasoning-model");
    assert.equal(body.reasoning_effort, region === INTL_REGION ? "max" : "low");
  }
});

async function waitFor(check, message) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail(message);
}

hostTest("Pi dual host: one refresh call updates both regions in parallel without crossing credentials", async () => {
  const { host } = await loadHost();
  const credentials = new host.InMemoryCredentialStore();
  const modelsStore = new host.InMemoryModelsStore();
  const models = host.createModels({ credentials, modelsStore });
  const started = new Map(regions.map(region => [region.id, deferred()]));
  const gates = new Map(regions.map(region => [region.id, deferred()]));
  const observed = new Map(regions.map(region => [region.id, []]));
  for (const region of regions) {
    await credentials.modify(region.id, async () => credential(region));
    models.setProvider(createWorkbuddyProvider({ region, api: noInference, client: createNativeClient({ region,
      fetch: async (input, init) => {
        observed.get(region.id).push({ url: String(input), authorization: init.headers.Authorization,
          domain: init.headers["X-Domain"] });
        started.get(region.id).resolve();
        await gates.get(region.id).promise;
        return json({ models: [{ id: region.id + "-model" }] });
      },
    }) }));
  }
  const refreshing = models.refresh({ providers: regions.map(region => region.id), allowNetwork: true, force: true });
  await Promise.all([...started.values()].map(value => value.promise));
  for (const region of regions) {
    const [request] = observed.get(region.id);
    assert.equal(new URL(request.url).origin, region.origin);
    assert.equal(request.authorization, "Bearer SYNTHETIC_ACCESS_" + region.id);
    assert.equal(request.domain, region.domain);
    assert.equal(observed.get(region.id).length, 1, "each region fetched only its own catalog");
    assert.equal(models.getModel(region.id, region.id + "-model"), undefined, "no model published before release");
  }
  gates.get(CN_REGION.id).resolve();
  await waitFor(() => models.getModel(CN_REGION.id, CN_REGION.id + "-model"), "CN publication did not arrive");
  assert.ok(models.getModel(CN_REGION.id, CN_REGION.id + "-model"));
  assert.equal(models.getModel(INTL_REGION.id, INTL_REGION.id + "-model"), undefined);
  gates.get(INTL_REGION.id).resolve();
  assert.equal((await refreshing).errors.size, 0);
  for (const region of regions) {
    const stored = await modelsStore.read(region.id);
    assert.deepEqual(stored.models.map(model => model.id), [region.id + "-model"]);
    assert.ok(stored.models.every(model => model.provider === region.id && model.baseUrl === region.baseUrl));
    assert.equal(models.getModel(region.id, otherRegion(region).id + "-model"), undefined);
  }
});
