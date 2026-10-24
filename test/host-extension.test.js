import assert from "node:assert/strict";
import { test } from "node:test";
import { resolve, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createWorkbuddyProvider } from "../src/native-provider.js";

const aiDist = process.env.PI_AI_TEST_PATH;
const agentDist = process.env.PI_AGENT_TEST_PATH || (aiDist ? resolve(aiDist, "../../../../dist") : undefined);
const hostTest = (name, fn) => test(name, { skip: !aiDist && "Set PI_AI_TEST_PATH to pi-ai/dist" }, fn);

hostTest("Pi 1.4 loader loads the actual package without installation, credentials, sessions, or network", async () => {
  const { loadExtensions } = await import(pathToFileURL(join(agentDist, "core/extensions/loader.js")).href);
  const root = fileURLToPath(new URL("../", import.meta.url));
  const before = globalThis.fetch;
  const loaded = await loadExtensions([join(root, "extensions/workbuddy.js")], root);
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 1);
  assert.deepEqual([...loaded.extensions[0].handlers.keys()], ["session_start"]);
  assert.equal(loaded.extensions[0].tools.size, 0);
  assert.deepEqual([...loaded.extensions[0].commands.keys()], ["workbuddy"]);
  assert.equal(loaded.runtime.pendingNativeProviderRegistrations.length, 1);
  assert.equal(loaded.runtime.pendingNativeProviderRegistrations[0].provider.id, "workbuddy");
  assert.equal(globalThis.fetch, before);
});

hostTest("Pi native dispatch for an unrelated provider never enters WorkBuddy auth, catalog, or transport", async () => {
  const host = await import(pathToFileURL(join(aiDist, "index.js")).href);
  const calls = { login: 0, refresh: 0, catalog: 0, transport: 0, other: 0 };
  const wb = createWorkbuddyProvider({
    api: {
      stream() { calls.transport++; throw new Error("Unexpected WorkBuddy stream"); },
      streamSimple() { calls.transport++; throw new Error("Unexpected WorkBuddy stream"); },
    },
    client: {
      async login() { calls.login++; throw new Error("Unexpected WorkBuddy login"); },
      async refresh() { calls.refresh++; throw new Error("Unexpected WorkBuddy refresh"); },
      async catalog() { calls.catalog++; throw new Error("Unexpected WorkBuddy catalog"); },
    },
  });
  const credentials = new host.InMemoryCredentialStore();
  await credentials.modify("workbuddy", async () => ({
    type: "oauth", origin: "https://www.workbuddy.ai", access: "SYNTHETIC_ACCESS", refresh: "SYNTHETIC_REFRESH",
    expires: Date.now() - 1000, userId: "synthetic-user",
  }));
  const models = host.createModels({ credentials });
  models.setProvider(wb);
  const model = { ...wb.getModels()[0], provider: "other", id: "synthetic-other" };
  const stream = () => {
    calls.other++;
    const result = host.createAssistantMessageEventStream();
    const message = {
      role: "assistant", api: model.api, provider: model.provider, model: model.id,
      content: [{ type: "text", text: "Other provider only" }], stopReason: "stop", timestamp: Date.now(),
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    };
    result.push({ type: "start", partial: message });
    result.push({ type: "done", reason: "stop", message });
    result.end();
    return result;
  };
  models.setProvider({
    id: "other", name: "Synthetic unrelated provider", getModels: () => [model],
    auth: { apiKey: { name: "Synthetic", resolve: async () => ({ auth: { apiKey: "SYNTHETIC_OTHER" }, source: "test" }) } },
    stream, streamSimple: stream,
  });
  for (let turn = 0; turn < 20; turn++) {
    const result = await models.completeSimple(model, { messages: [{ role: "user", content: "synthetic", timestamp: Date.now() }] });
    assert.equal(result.content[0].text, "Other provider only");
  }
  assert.deepEqual(calls, { login: 0, refresh: 0, catalog: 0, transport: 0, other: 20 });
});
