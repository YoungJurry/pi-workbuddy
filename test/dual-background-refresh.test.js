import assert from "node:assert/strict";
import { test } from "node:test";
import { INTL_REGION, CN_REGION } from "../src/regions.js";
import { registerNativeLifecycle, recoverSelectedModel } from "../src/native-lifecycle.js";
import { registerNativeCommands } from "../src/native-provider.js";

const regions = [INTL_REGION, CN_REGION];
const success = () => ({ aborted: false, errors: new Map() });
const settle = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function harness({ selected = INTL_REGION, configured = regions.map(region => region.id), refresh } = {}) {
  const hooks = new Map(), hookNames = [], commands = new Map(), notices = [], selections = [], requests = [];
  const providers = regions.map(region => ({
    id: region.id, name: region.name, fallbackName: region.fallbackName,
    getModels: () => [{ provider: region.id, id: "shared-model", name: region.name + " live", contextWindow: 16384 }],
  }));
  const configuredProviders = new Set(configured);
  const ctx = {
    mode: "print", model: { provider: selected.id, id: "shared-model", name: selected.name + " cached", contextWindow: 8192 },
    isIdle: () => true, ui: { notify: message => notices.push(message) }, sessionManager: { getBranch: () => [] },
    modelRegistry: {
      hasConfiguredAuth: model => configuredProviders.has(model.provider),
      refresh(options) { requests.push(options); return refresh?.(options) ?? Promise.resolve(success()); },
    },
  };
  const pi = {
    on(name, handler) { hookNames.push(name); hooks.set(name, handler); },
    registerCommand: (name, command) => commands.set(name, command),
    async setModel(model) { selections.push(model); ctx.model = model; return true; },
  };
  registerNativeLifecycle(pi, providers);
  return { pi, ctx, providers, requests, selections, notices, hookNames, commands,
    start: () => hooks.get("session_start")({}, ctx), stop: () => hooks.get("session_shutdown")({}, ctx) };
}

test("dual interactive startup leaves both regions to Pi with no extension-owned refresh", async () => {
  for (const selected of regions) {
    const a = harness({ selected, refresh: () => { throw new Error("No duplicate startup refresh"); } });
    a.ctx.mode = "tui";
    assert.deepEqual(a.hookNames, ["session_start", "session_shutdown"]);
    assert.equal(a.start(), undefined);
    await settle();
    assert.deepEqual(a.requests, []);
    assert.deepEqual(a.selections, []);
    assert.deepEqual(a.notices, []);
    assert.equal(a.ctx.model.name, selected.name + " cached");
  }
});

test("dual startup queries only regions with configured credentials", async () => {
  for (const configured of [[], ["workbuddy"], ["workbuddy-cn"]]) {
    const a = harness({ configured });
    a.start();
    await settle();
    assert.deepEqual(a.requests.map(request => request.providers[0]), configured);
  }
});

test("dual headless startup waits for both regional discoveries, not just the selected region", async () => {
  for (const selected of regions) {
    const pending = new Map(regions.map(region => [region.id, deferred()]));
    const a = harness({ selected, refresh: ({ providers }) => pending.get(providers[0]).promise });
    a.ctx.mode = "print";
    const started = a.start();
    assert.equal(typeof started?.then, "function");
    let complete = false;
    void started.then(() => { complete = true; });
    assert.equal(a.requests.length, 2, "both requests start before either resolves");
    pending.get(selected.id).resolve(success());
    await settle();
    assert.equal(complete, false);
    assert.deepEqual(a.selections.map(model => model.provider), [selected.id]);
    pending.get(regions.find(region => region !== selected).id).resolve(success());
    await started;
    assert.equal(complete, true);
    assert.equal(a.selections.length, 1);
  }
});

test("switching to interactive mode cancels old headless work without starting another batch", async () => {
  const pending = deferred();
  const a = harness({ refresh: () => pending.promise });
  const started = a.start();
  assert.equal(a.requests.length, 2);
  a.ctx.mode = "tui";
  assert.equal(a.start(), undefined);
  assert.equal(a.requests.length, 2);
  for (const request of a.requests) assert.equal(request.signal.aborted, true);
  pending.resolve(success());
  await started;
  assert.deepEqual(a.selections, []);
});

test("shutdown cancels both regional operations and suppresses both late completions", async () => {
  const pending = new Map(regions.map(region => [region.id, deferred()]));
  const a = harness({ refresh: ({ providers }) => pending.get(providers[0]).promise });
  a.start();
  assert.equal(a.stop(), undefined);
  for (const request of a.requests) assert.equal(request.signal.aborted, true);
  for (const operation of pending.values()) operation.resolve(success());
  await settle();
  assert.equal(a.selections.length, 0);
  assert.equal(a.notices.length, 0);
});

test("a new session cancels both old regions without losing either new cancellation controller", async () => {
  const pending = [];
  const a = harness({ refresh: () => { const operation = deferred(); pending.push(operation); return operation.promise; } });
  a.start();
  a.start();
  assert.equal(a.requests.length, 4);
  for (const request of a.requests.slice(0, 2)) assert.equal(request.signal.aborted, true);
  for (const request of a.requests.slice(2)) assert.equal(request.signal.aborted, false);
  for (const operation of pending.slice(0, 2)) operation.resolve(success());
  await settle();
  a.stop();
  for (const request of a.requests.slice(2)) assert.equal(request.signal.aborted, true);
  for (const operation of pending.slice(2)) operation.resolve(success());
  await settle();
  assert.equal(a.selections.length, 0);
});

test("operation cancellation reaches both regions without cancellation warnings", async () => {
  const controller = new AbortController();
  const a = harness({ refresh: ({ signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  }) });
  a.ctx.signal = controller.signal;
  a.start();
  controller.abort();
  for (const request of a.requests) assert.equal(request.signal.aborted, true);
  await settle();
  assert.equal(a.notices.length, 0);
  assert.equal(a.selections.length, 0);
});

test("pending regional refreshes cannot replace a model selected in the other region", async () => {
  const pending = new Map(regions.map(region => [region.id, deferred()]));
  const a = harness({ refresh: ({ providers }) => pending.get(providers[0]).promise });
  a.start();
  const chosen = { provider: CN_REGION.id, id: "shared-model", name: "Explicit CN selection", contextWindow: 8192 };
  a.ctx.model = chosen;
  for (const operation of pending.values()) operation.resolve(success());
  await settle();
  assert.equal(a.ctx.model, chosen);
  assert.equal(a.selections.length, 0);
});

test("a regional failure neither hides the other region's success nor recovers its selected model", async () => {
  const a = harness({ selected: CN_REGION, refresh: async ({ providers }) => providers[0] === INTL_REGION.id
    ? { aborted: false, errors: new Map([[INTL_REGION.id, new Error("synthetic intl failure")]]) } : success() });
  a.ctx.mode = "print";
  await a.start();
  assert.deepEqual(a.selections.map(model => model.provider), [CN_REGION.id]);
  assert.equal(a.notices.length, 1);
  assert.match(a.notices[0], /synthetic intl failure/);
});

test("a disposed UI in one region cannot drop cancellation or finish headless discovery early", async () => {
  for (const mode of ["print", "json", "rpc"]) {
    const pending = deferred();
    const a = harness({ refresh: ({ providers }) => providers[0] === INTL_REGION.id
      ? Promise.reject(new Error("synthetic regional failure")) : pending.promise });
    a.ctx.mode = mode;
    a.ctx.ui.notify = () => { throw new Error("context disposed"); };
    let completed = false;
    const started = a.start();
    const completion = started?.then(() => { completed = true; }, () => { completed = true; });
    await settle();
    assert.equal(completed, false, "headless startup must still wait for the pending region");
    a.stop();
    assert.equal(a.requests[1].signal.aborted, true, "the remaining region must retain shutdown cancellation");
    pending.resolve(success());
    await completion;
    await settle();
    assert.equal(a.selections.length, 0);
  }
});

test("regional commands use provider IDs for refresh and never refresh the other account", async () => {
  const a = harness();
  for (const provider of a.providers) registerNativeCommands(a.pi, provider);
  assert.deepEqual([...a.commands.keys()], ["workbuddy", "workbuddy-cn"]);
  for (const region of regions) {
    a.requests.length = 0;
    await a.commands.get(region.id).handler("status", a.ctx);
    assert.equal(a.requests.length, 0);
    await a.commands.get(region.id).handler("refresh", a.ctx);
    assert.deepEqual(a.requests.map(request => request.providers), [[region.id]]);
  }
});

test("fallback recovery ignores another provider's model-change history", async () => {
  for (const region of regions) {
    const other = regions.find(value => value !== region);
    const selections = [];
    const selected = { provider: region.id, id: "default-model", name: region.fallbackName };
    const local = { ...selected, name: "Regional default" };
    const provider = { id: region.id, fallbackName: region.fallbackName, getModels: () => [local,
      { provider: region.id, id: "foreign-history-model", name: "Must not recover foreign history" }] };
    const ctx = { model: selected, isIdle: () => true, sessionManager: { getBranch: () => [
      { type: "model_change", provider: other.id, modelId: "foreign-history-model" },
    ] } };
    await recoverSelectedModel({ async setModel(model) { selections.push(model); return true; } }, provider, ctx);
    assert.deepEqual(selections, [local]);
  }
});

test("fallback recovery follows each region's own fallback name and SG policy", async () => {
  for (const region of regions) {
    const selections = [];
    const selected = { provider: region.id, id: "default-model", name: region.fallbackName };
    const previousId = "deepseek-synthetic-sg";
    const excludeSg = region.excludeSg !== false;
    const provider = { id: region.id, fallbackName: region.fallbackName, excludeSg, getModels: () => [
      { provider: region.id, id: previousId, name: "SG model" },
      { provider: region.id, id: "deepseek-synthetic", name: "Base model" },
    ] };
    const ctx = { model: selected, isIdle: () => true, sessionManager: { getBranch: () => [
      { type: "model_change", provider: region.id, modelId: previousId },
    ] } };
    await recoverSelectedModel({ async setModel(model) { selections.push(model); return true; } }, provider, ctx);
    assert.deepEqual(selections.map(model => model.id), [excludeSg ? "deepseek-synthetic" : previousId]);
  }
});

test("the legacy single-provider lifecycle still refreshes, waits headless, and cancels", async () => {
  const hooks = new Map(), requests = [], selections = [];
  const pending = deferred();
  const provider = { id: INTL_REGION.id, fallbackName: INTL_REGION.fallbackName,
    getModels: () => [{ provider: INTL_REGION.id, id: "shared-model", name: "Live", contextWindow: 16384 }] };
  const ctx = {
    mode: "print", model: { provider: INTL_REGION.id, id: "shared-model", name: "Cached", contextWindow: 8192 },
    isIdle: () => true, ui: { notify() {} }, sessionManager: { getBranch: () => [] },
    modelRegistry: { hasConfiguredAuth: () => true,
      refresh(options) { requests.push(options); return pending.promise; } },
  };
  registerNativeLifecycle({ on: (name, handler) => hooks.set(name, handler),
    async setModel(model) { selections.push(model); return true; } }, provider);
  assert.deepEqual([...hooks.keys()], ["session_start", "session_shutdown"]);
  const started = hooks.get("session_start")({}, ctx);
  assert.equal(typeof started?.then, "function");
  assert.deepEqual(requests.map(request => request.providers), [[INTL_REGION.id]]);
  pending.resolve(success());
  await started;
  assert.deepEqual(selections.map(model => model.provider), [INTL_REGION.id]);
});
