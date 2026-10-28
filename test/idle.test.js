import assert from "node:assert/strict";
import { test } from "node:test";
import { registerWorkbuddy } from "../src/extension.js";
import { createWorkbuddyProvider } from "../src/native-provider.js";
import { recoverSelectedModel } from "../src/native-lifecycle.js";
import { projectModels } from "../src/native-models.js";
import { catalogCacheEntry, catalogCacheKey } from "../src/native-catalog-cache.js";
import { ORIGIN } from "../src/native-client.js";
import { WorkbuddyError } from "../src/native-errors.js";

const credential = () => ({ type: "oauth", origin: ORIGIN, userId: "synthetic-user",
  access: "SYNTHETIC_ACCESS", refresh: "SYNTHETIC_REFRESH", expires: Date.now() + 3600000 });
const noInference = { stream() { throw new Error("Unexpected inference"); }, streamSimple() { throw new Error("Unexpected inference"); } };

const settleRefresh = () => new Promise(resolve => setImmediate(resolve));

async function startSession(a) {
  await a.hooks.get("session_start")({}, a.ctx);
  await settleRefresh();
}

function assembly() {
  const hooks = new Map(), commands = new Map(), registered = [], notices = [];
  const counters = { catalog: 0, selected: 0, refresh: 0 };
  const fetchBefore = globalThis.fetch;
  const pi = {
    registerProvider(provider) { registered.push(provider); },
    registerCommand(name, config) { commands.set(name, config); },
    on(name, handler) {
      assert.ok(["session_start", "session_shutdown"].includes(name), "no global per-turn/model/UI hooks are permitted");
      assert.ok(!hooks.has(name), "only one handler per lifecycle event");
      hooks.set(name, handler);
    },
    async setModel() { counters.selected++; return true; },
    registerTool() { throw new Error("No extra tools are permitted"); },
  };
  const provider = registerWorkbuddy(pi, {
    api: noInference,
    client: { async catalog() { counters.catalog++; return { models: [{ id: "synthetic-live" }] }; } },
  });
  let stored;
  const selected = { provider: "other", id: "other-model" };
  const ctx = {
    mode: "print",
    model: selected,
    isIdle: () => true,
    sessionManager: { getBranch() { throw new Error("Do not scan another provider's history"); } },
    ui: { notify(message, level) { notices.push({ message, level }); } },
    modelRegistry: {
      hasConfiguredAuth: () => true,
      async refresh(options) {
        counters.refresh++;
        assert.deepEqual(options.providers, ["workbuddy"]);
        assert.equal(options.force, true);
        const context = {
          credential: credential(), stored,
          force: options.force, signal: options.signal ?? new AbortController().signal,
          publish: async ({ persist, update }) => { if (persist) stored = persist; update?.(); return true; },
        };
        await provider.refreshModels({ ...context, allowNetwork: false });
        await provider.refreshModels({ ...context, allowNetwork: options.allowNetwork ?? true });
        return { aborted: false, errors: new Map() };
      },
    },
  };
  return { pi, provider, ctx, hooks, commands, registered, counters, notices, fetchBefore };
}

test("factory is inert, registers one native provider, one command and only session lifecycle hooks", () => {
  const a = assembly();
  assert.deepEqual([...a.hooks.keys()], ["session_start", "session_shutdown"]);
  assert.deepEqual([...a.commands.keys()], ["workbuddy"]);
  assert.equal(a.registered.length, 1);
  assert.equal(a.registered[0].id, "workbuddy");
  assert.equal(a.counters.catalog, 0);
  assert.equal(a.counters.refresh, 0);
  assert.equal(globalThis.fetch, a.fetchBefore);
  assert.equal("promptCache" in a.provider.getModels()[0], false, "no idle cache warming");
});

test("headless startup refreshes once even with another model selected, without touching its history or selection", async () => {
  const a = assembly();
  await startSession(a);
  assert.equal(a.counters.catalog, 1);
  assert.equal(a.counters.refresh, 1);
  assert.equal(a.counters.selected, 0);
  assert.equal(a.ctx.model.provider, "other");
  assert.equal(a.provider.getModels()[0].id, "synthetic-live");
});

test("ordinary turns under other providers have no WorkBuddy callback to dispatch", async () => {
  const a = assembly();
  await startSession(a);
  const before = { ...a.counters };
  const events = ["before_agent_start", "agent_start", "turn_start", "context",
    "context_with_system", "before_provider_headers", "before_provider_request",
    "after_provider_response", "provider_stream_event", "message_start", "message_update",
    "message_end", "tool_call", "tool_result", "turn_end", "agent_end", "agent_settled", "model_select"];
  for (let turn = 0; turn < 100; turn++) {
    for (const event of events) {
      assert.equal(a.hooks.get(event), undefined);
    }
  }
  await Promise.resolve();
  assert.deepEqual(a.counters, before);
  assert.equal(globalThis.fetch, a.fetchBefore);
});

test("unconfigured startup does not request credentials, refresh a directory, or send inference", async () => {
  const a = assembly();
  a.ctx.modelRegistry.hasConfiguredAuth = () => false;
  await startSession(a);
  assert.equal(a.counters.refresh, 0);
  assert.equal(a.counters.catalog, 0);
});

test("offline headless startup explicitly requests cache-only refresh", async () => {
  const saved = process.env.PI_OFFLINE;
  process.env.PI_OFFLINE = "1";
  try {
    const a = assembly();
    await startSession(a);
    assert.equal(a.counters.refresh, 1);
    assert.equal(a.counters.catalog, 0);
  } finally {
    if (saved === undefined) delete process.env.PI_OFFLINE;
    else process.env.PI_OFFLINE = saved;
  }
});

test("unforced discovery restores cache offline, fetches once online, then reuses the remote catalog", async () => {
  let requests = 0;
  const provider = createWorkbuddyProvider({ api: noInference,
    client: { async catalog() { requests++; return { models: [{ id: "live-model" }] }; } } });
  const cached = projectModels({ models: [{ id: "cached-model" }] });
  const context = { credential: credential(), allowNetwork: false, force: false,
    signal: new AbortController().signal, stored: catalogCacheEntry(cached, catalogCacheKey(credential())),
    async publish({ update }) { update?.(); return true; } };
  await provider.refreshModels(context);
  assert.equal(requests, 0);
  assert.equal(provider.getModels()[0].id, "cached-model");
  await provider.refreshModels({ ...context, allowNetwork: true });
  assert.equal(requests, 1);
  assert.equal(provider.getModels()[0].id, "live-model");
  await provider.refreshModels({ ...context, allowNetwork: true });
  assert.equal(requests, 1);
});

test("startup failures retain upstream messages; other model never changes", async () => {
  const a = assembly();
  a.ctx.modelRegistry.refresh = async () => ({ aborted: false, errors: new Map([
    ["workbuddy", new WorkbuddyError("http", "SYNTHETIC_PRIVATE_BODY", { status: 403, businessCode: 11212 })],
  ]) });
  await startSession(a);
  assert.equal(a.notices.length, 1);
  assert.match(a.notices[0].message, /HTTP 403/);
  assert.match(a.notices[0].message, /SYNTHETIC_PRIVATE_BODY/);
  assert.equal(a.counters.selected, 0);
});

test("cancelled startup does not emit misleading failure notifications", async () => {
  const a = assembly();
  a.ctx.signal = AbortSignal.abort();
  a.ctx.modelRegistry.refresh = async () => { throw new Error("cancelled"); };
  await startSession(a);
  assert.equal(a.notices.length, 0);
});

test("status and doctor do not resolve auth or request a model/catalog", async () => {
  const a = assembly();
  for (const action of ["status", "doctor"]) await a.commands.get("workbuddy").handler(action, a.ctx);
  assert.equal(a.notices.length, 2);
  assert.equal(a.counters.refresh, 0);
  assert.equal(a.counters.catalog, 0);
});

test("explicit refresh waits for idle and does not register any additional event", async () => {
  const a = assembly();
  let waits = 0;
  a.ctx.waitForIdle = async () => { waits++; };
  await a.commands.get("workbuddy").handler("refresh", a.ctx);
  assert.equal(waits, 1);
  assert.equal(a.counters.catalog, 1);
  assert.deepEqual([...a.hooks.keys()], ["session_start", "session_shutdown"]);
});

test("startup repairs only a still-selected idle WorkBuddy model, not a raced selection", async () => {
  const a = assembly();
  const old = { ...a.provider.getModels()[0], id: "synthetic-live" };
  a.ctx.sessionManager = { getBranch: () => [] };
  a.ctx.model = old;
  await startSession(a);
  assert.equal(a.counters.selected, 1);
  a.ctx.model = { provider: "other", id: "new-choice" };
  await recoverSelectedModel(a.pi, a.provider, a.ctx, old);
  assert.equal(a.counters.selected, 1);
  a.ctx.model = old;
  a.ctx.isIdle = () => false;
  await recoverSelectedModel(a.pi, a.provider, a.ctx, old);
  assert.equal(a.counters.selected, 1);
});
