import assert from "node:assert/strict";
import { test } from "node:test";
import { registerNativeLifecycle } from "../src/native-lifecycle.js";
import { registerNativeCommands } from "../src/native-provider.js";

const success = () => ({ aborted: false, errors: new Map() });
const settleRefresh = () => new Promise(resolve => setImmediate(resolve));

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function harness(refresh) {
  const hooks = new Map(), commands = new Map(), notices = [], selections = [], requests = [];
  const cached = { provider: "workbuddy", id: "model", name: "Cached model", contextWindow: 8192 };
  const live = { ...cached, name: "Updated model", contextWindow: 16384 };
  const provider = { getModels: () => [live] };
  const pi = {
    on: (name, handler) => hooks.set(name, handler),
    registerCommand: (name, command) => commands.set(name, command),
    async setModel(model) { selections.push(model); return true; },
  };
  const ctx = {
    mode: "tui", model: cached, isIdle: () => true,
    ui: { notify: message => notices.push(message) },
    sessionManager: { getBranch: () => [] },
    modelRegistry: {
      hasConfiguredAuth: () => true,
      refresh(options) { requests.push(options); return refresh(options); },
    },
  };
  registerNativeLifecycle(pi, provider);
  const start = () => hooks.get("session_start")({}, ctx);
  const stop = () => hooks.get("session_shutdown")({}, ctx);
  return { pi, provider, ctx, start, stop, commands, notices, selections, requests };
}

test("interactive startup returns immediately while discovery is still pending", async () => {
  const pending = deferred();
  const a = harness(() => pending.promise);
  assert.equal(a.start(), undefined);
  assert.equal(a.requests.length, 1);
  assert.equal(a.ctx.model.name, "Cached model");
  assert.equal(a.selections.length, 0);
  await settleRefresh();
  assert.equal(a.selections.length, 0, "startup did not need discovery to complete");
  pending.resolve(success());
  await settleRefresh();
  assert.equal(a.selections[0].name, "Updated model");
});

test("a background refresh cannot overwrite a model selected while discovery was pending", async () => {
  const pending = deferred();
  const a = harness(() => pending.promise);
  a.start();
  const chosen = { provider: "other", id: "chosen-model" };
  a.ctx.model = chosen;
  pending.resolve(success());
  await settleRefresh();
  assert.equal(a.ctx.model, chosen);
  assert.equal(a.selections.length, 0);
});

test("a background refresh does not switch models during an active turn", async () => {
  const pending = deferred();
  const a = harness(() => pending.promise);
  a.start();
  a.ctx.isIdle = () => false;
  pending.resolve(success());
  await settleRefresh();
  assert.equal(a.selections.length, 0);
});

test("shutdown aborts discovery without waiting or reporting a cancellation as a failure", async () => {
  const a = harness(({ signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  }));
  a.start();
  const signal = a.requests[0].signal;
  assert.equal(signal.aborted, false);
  assert.equal(a.stop(), undefined);
  assert.equal(signal.aborted, true);
  await settleRefresh();
  assert.equal(a.notices.length, 0);
  assert.equal(a.selections.length, 0);
});

test("late success after shutdown cannot recover an obsolete session's model", async () => {
  const pending = deferred();
  const a = harness(() => pending.promise);
  a.start();
  a.stop();
  pending.resolve(success());
  await settleRefresh();
  assert.equal(a.notices.length, 0);
  assert.equal(a.selections.length, 0);
});

test("a new session cancels the old refresh, whose completion cannot clear the new controller", async () => {
  const first = deferred(), second = deferred();
  let calls = 0;
  const a = harness(() => (++calls === 1 ? first : second).promise);
  a.start();
  a.start();
  assert.equal(a.requests[0].signal.aborted, true);
  assert.equal(a.requests[1].signal.aborted, false);
  first.resolve(success());
  await settleRefresh();
  a.stop();
  assert.equal(a.requests[1].signal.aborted, true);
  second.resolve(success());
  await settleRefresh();
  assert.equal(a.selections.length, 0);
});

test("the operation signal still cancels a detached refresh", async () => {
  const pending = deferred(), controller = new AbortController();
  const a = harness(() => pending.promise);
  a.ctx.signal = controller.signal;
  a.start();
  controller.abort();
  assert.equal(a.requests[0].signal.aborted, true);
  pending.reject(new Error("cancelled"));
  await settleRefresh();
  assert.equal(a.notices.length, 0);
});

test("headless startup still waits for discovery before the first prompt", async () => {
  const pending = deferred();
  const a = harness(() => pending.promise);
  a.ctx.mode = "print";
  const started = a.start();
  assert.equal(typeof started?.then, "function");
  let completed = false;
  void started.then(() => { completed = true; });
  await settleRefresh();
  assert.equal(completed, false);
  pending.resolve(success());
  await started;
  assert.equal(completed, true);
  assert.equal(a.selections.length, 1);
});

test("explicit manual refresh still waits and reports success", async () => {
  const pending = deferred();
  const a = harness(() => pending.promise);
  registerNativeCommands(a.pi, a.provider);
  let completed = false;
  const command = a.commands.get("workbuddy").handler("refresh", a.ctx)
    .then(() => { completed = true; });
  await settleRefresh();
  assert.equal(completed, false);
  assert.equal(a.notices.length, 0);
  pending.resolve(success());
  await command;
  assert.equal(completed, true);
  assert.match(a.notices[0], /catalog refreshed/);
});

test("an invalidated UI cannot produce an unhandled background rejection", async () => {
  const a = harness(async () => { throw new Error("discovery failed"); });
  a.ctx.ui.notify = () => { throw new Error("context disposed"); };
  assert.equal(a.start(), undefined);
  await settleRefresh();
});
