import assert from "node:assert/strict";
import { test } from "node:test";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createWorkbuddyProvider } from "../src/native-provider.js";
import { registerNativeLifecycle } from "../src/native-lifecycle.js";
import { projectModels } from "../src/native-models.js";
import { catalogCacheEntry, catalogCacheKey } from "../src/native-catalog-cache.js";
import { INTL_REGION, CN_REGION } from "../src/regions.js";

const regions = [INTL_REGION, CN_REGION];
const noInference = { stream() { throw new Error("Inference prohibited"); }, streamSimple() { throw new Error("Inference prohibited"); } };
const credential = (region, userId = "synthetic-user") => ({ type: "oauth", origin: region.origin, domain: region.domain,
  userId, access: "SYNTHETIC_ACCESS", refresh: "SYNTHETIC_REFRESH", expires: Date.now() + 3600000 });
const config = id => ({ models: [{ id, supportsToolCall: true }],
  agents: [{ name: "cli", tags: ["cli", "default"], models: [id] }] });
const ids = provider => provider.getModels().map(model => model.id);
const context = (region, extra = {}) => ({ credential: credential(region), allowNetwork: true,
  signal: new AbortController().signal, async publish({ update }) { update?.(); return true; }, ...extra });
const settle = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

for (const region of regions) {
  test(region.id + ": unforced refresh fetches until publication succeeds, then only force fetches", async () => {
    let calls = 0;
    const provider = createWorkbuddyProvider({ region, api: noInference,
      client: { async catalog() { calls++; return config("live-" + calls); } } });
    await provider.refreshModels(context(region, { force: false, async publish() { return false; } }));
    assert.equal(provider.getCatalogStatus().source, "fallback");
    await provider.refreshModels(context(region));
    assert.equal(calls, 2, "rejected publication must not count as successful discovery");
    assert.deepEqual(ids(provider), ["live-2"]);
    await provider.refreshModels(context(region, { force: false }));
    await provider.refreshModels(context(region));
    assert.equal(calls, 2, "ordinary enumeration after success is local");
    await provider.refreshModels(context(region, { force: true }));
    assert.equal(calls, 3);
    assert.deepEqual(ids(provider), ["live-3"]);
    await provider.refreshModels(context(region, { credential: credential(region, "other-user") }));
    assert.equal(calls, 4, "account changes need their own successful discovery");
  });

  test(region.id + ": failed first discovery can be retried by the next unforced host pass", async () => {
    let calls = 0;
    const stored = catalogCacheEntry(projectModels(config("cached"), region), catalogCacheKey(credential(region), region));
    const provider = createWorkbuddyProvider({ region, api: noInference, client: {
      async catalog() { if (++calls === 1) throw new Error("Synthetic catalog failure"); return config("recovered"); },
    } });
    await assert.rejects(provider.refreshModels(context(region, { stored })), /Synthetic catalog failure/);
    assert.equal(calls, 1, "no autonomous retry");
    assert.equal(provider.getCatalogStatus().source, "cache");
    assert.deepEqual(ids(provider), ["cached"]);
    await provider.refreshModels(context(region, { stored }));
    assert.equal(calls, 2);
    assert.deepEqual(ids(provider), ["recovered"]);
    assert.equal(provider.getCatalogStatus().lastError, undefined);
  });

  test(region.id + ": canceled cache restoration cannot overwrite replacement diagnostics", async () => {
    const provider = createWorkbuddyProvider({ region, api: noInference,
      client: { async catalog() { return config("replacement"); } } });
    const stored = catalogCacheEntry(projectModels(config("cached"), region), catalogCacheKey(credential(region), region));
    const controller = new AbortController(), publishing = deferred(), started = deferred();
    const old = provider.refreshModels(context(region, { stored, allowNetwork: false, signal: controller.signal,
      async publish() { started.resolve(); return publishing.promise; } }));
    await started.promise;
    await provider.refreshModels(context(region));
    controller.abort();
    publishing.reject(new Error("Late canceled cache publication"));
    await old;
    assert.deepEqual(ids(provider), ["replacement"]);
    assert.deepEqual(provider.getCatalogStatus(), { source: "remote", lastError: undefined });
  });

  test(region.id + ": offline, unconfigured and already-aborted refreshes never discover online", async () => {
    let calls = 0;
    const provider = createWorkbuddyProvider({ region, api: noInference,
      client: { async catalog() { calls++; throw new Error("Must not fetch"); } } });
    for (const extra of [{ allowNetwork: false }, { credential: undefined }, { signal: AbortSignal.abort() }]) {
      await provider.refreshModels(context(region, extra));
    }
    assert.equal(calls, 0);
    assert.equal(provider.getCatalogStatus().source, "fallback");
  });
}

const aiDist = process.env.PI_AI_TEST_PATH;
const agentDist = process.env.PI_AGENT_TEST_PATH || (aiDist ? resolve(aiDist, "../../../../dist") : undefined);
async function loadHost() {
  const host = await import(pathToFileURL(join(aiDist, "index.js")).href);
  const { ModelRuntime } = await import(pathToFileURL(join(agentDist, "core/model-runtime.js")).href);
  const { ModelRegistry } = await import(pathToFileURL(join(agentDist, "core/model-registry.js")).href);
  const { refreshModelCatalogs } = await import(pathToFileURL(join(agentDist, "modes/interactive/model-catalog-refresh.js")).href);
  return { host, ModelRuntime, ModelRegistry, refreshModelCatalogs };
}

for (const cacheState of ["missing", "obsolete", "valid"]) {
  test("Pi interactive startup handoff completes both regional catalogs with " + cacheState + " caches", {
    skip: !aiDist && "Set PI_AI_TEST_PATH to pi-ai/dist", timeout: 15000,
  }, async t => {
    const { host, ModelRuntime, ModelRegistry, refreshModelCatalogs } = await loadHost();
    const credentials = new host.InMemoryCredentialStore(), modelsStore = new host.InMemoryModelsStore();
    for (const region of regions) {
      await credentials.modify(region.id, async () => credential(region));
      if (cacheState !== "missing") {
        const entry = catalogCacheEntry(projectModels(config("disk-cached"), region), catalogCacheKey(credential(region), region));
        if (cacheState === "obsolete") delete entry.projectionVersion;
        await modelsStore.write(region.id, entry);
      }
    }
    // This is the coding-agent runtime, not just pi-ai's Models collection.
    const runtime = await ModelRuntime.create({ credentials, modelsStore, modelsPath: null });
    const hooks = new Map(), notices = [], calls = new Map(), signals = new Map();
    const started = new Map(regions.map(region => [region.id, deferred()]));
    const delayed = new Map(regions.map(region => [region.id, deferred()]));
    const providers = regions.map(region => createWorkbuddyProvider({ region, api: noInference, client: {
      async catalog(_credential, signal) {
        const count = (calls.get(region.id) ?? 0) + 1;
        calls.set(region.id, count);
        if (count === 1) {
          signals.set(region.id, signal);
          started.get(region.id).resolve();
          // Ignore abort deliberately: a late old result/error must not affect the replacement.
          return delayed.get(region.id).promise;
        }
        return config("current-" + region.id);
      },
    } }));
    for (const provider of providers) runtime.registerNativeProvider(provider);
    await runtime.refresh({ allowNetwork: false });
    assert.equal(calls.size, 0, "registration/cache restoration must not fetch");
    const selected = { provider: "other", id: "unchanged" };
    const pi = {
      on(name, handler) { assert.ok(!hooks.has(name)); hooks.set(name, handler); },
      async setModel() { throw new Error("Do not replace another provider's model"); },
    };
    registerNativeLifecycle(pi, providers);
    t.after(() => {
      hooks.get("session_shutdown")({}, ctx);
      for (const gate of delayed.values()) gate.resolve(config("late-obsolete"));
    });
    const ctx = { mode: "tui", model: selected, isIdle: () => true,
      modelRegistry: new ModelRegistry(runtime), ui: { notify: message => notices.push(message) } };
    assert.deepEqual([...hooks.keys()], ["session_start", "session_shutdown"], "no additional hooks");
    assert.equal(hooks.get("session_start")({}, ctx), undefined, "interactive startup stays non-blocking");
    await Promise.all([...started.values()].map(gate => gate.promise));
    // InteractiveMode.run() calls this AFTER init() emits session_start. It has no force flag.
    const result = await refreshModelCatalogs(runtime, new AbortController().signal);
    for (const region of regions) {
      assert.equal(result.errors.has(region.id), false);
      assert.equal(signals.get(region.id).aborted, true, "host supersedes forced startup discovery");
      assert.equal(calls.get(region.id), 2, "the replacement must finish online discovery");
      assert.deepEqual(runtime.getModels(region.id).map(model => model.id), ["current-" + region.id]);
      const stored = await modelsStore.read(region.id);
      assert.deepEqual(stored.models.map(model => model.id), ["current-" + region.id]);
    }
    for (const gate of delayed.values()) {
      if (cacheState === "valid") gate.reject(new Error("Late canceled request failure"));
      else gate.resolve(config("late-obsolete"));
    }
    await settle();
    await settle();
    for (const provider of providers) {
      assert.deepEqual(ids(provider), ["current-" + provider.id]);
      assert.deepEqual(provider.getCatalogStatus(), { source: "remote", lastError: undefined });
    }
    assert.deepEqual(notices, [], "superseded startup requests are not reported as failures");
    assert.equal(ctx.model, selected);
    await refreshModelCatalogs(runtime, new AbortController().signal);
    assert.deepEqual([...calls.values()], [2, 2], "later ordinary refreshes reuse successful catalogs");
    await runtime.refresh({ providers: [INTL_REGION.id], force: true });
    assert.deepEqual([...calls.values()], [3, 2], "manual force refresh only fetches its own region");
    assert.deepEqual([...hooks.keys()], ["session_start", "session_shutdown"]);
  });
}
