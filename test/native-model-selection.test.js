import assert from "node:assert/strict";
import { test } from "node:test";
import { join, resolve } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { projectModels } from "../src/native-models.js";
import { describeFailure } from "../src/native-errors.js";
import { createWorkbuddyProvider } from "../src/native-provider.js";
import { catalogCacheKey, catalogCacheEntry, restoreCatalog } from "../src/native-catalog-cache.js";
import { INTL_REGION, CN_REGION } from "../src/regions.js";

const ids = models => models.map(model => model.id);
const model = (id, extra = {}) => ({ id, supportsToolCall: true, ...extra });
const cli = (models, extra = {}) => ({ name: "cli", tags: ["cli", "default"], models, ...extra });
const api = { stream() { throw new Error("Inference prohibited"); }, streamSimple() { throw new Error("Inference prohibited"); } };
const credential = region => ({ type: "oauth", origin: region.origin, domain: region.domain,
  userId: "synthetic-user", access: "SYNTHETIC_ACCESS", refresh: "SYNTHETIC_REFRESH", expires: Date.now() + 3600000 });
const context = (region, extra = {}) => ({ credential: credential(region), allowNetwork: true, force: true,
  signal: new AbortController().signal, async publish({ update }) { update(); return true; }, ...extra });

// Deliberately synthetic: no private catalog bodies or hardcoded live model IDs.
function mixedCatalog() {
  const current = Array.from({ length: 19 }, (_, i) => model("current-" + i));
  return {
    agents: [cli(ids(current).reverse(), { modelTags: ["craft"] })],
    models: [
      ...current,
      ...Array.from({ length: 28 }, (_, i) => model("retired-" + i, { tags: ["craft"] })),
      ...Array.from({ length: 9 }, (_, i) => ({ id: "completion-" + i, maxOutputTokens: 256 })),
      { id: "image", tags: ["text-to-image"] }, { id: "image-edit", tags: ["image-to-image"] },
      { id: "video", tags: ["text-to-video"] }, { id: "video-edit", tags: ["image-to-video"] },
      { id: "internal-lite", disabled: true },
    ],
  };
}

test("CN-style 61-definition registry yields only the agent's 19 candidates in agent order", () => {
  const config = mixedCatalog(), original = structuredClone(config);
  assert.equal(config.models.length, 61);
  assert.equal(config.availableModels, undefined);
  for (const region of [INTL_REGION, CN_REGION]) {
    const projected = projectModels(config, region);
    assert.deepEqual(ids(projected), config.agents[0].models);
    assert.ok(projected.every(model => model.provider === region.id && model.baseUrl === region.baseUrl));
  }
  assert.deepEqual(config, original, "projection must not mutate server configuration");
});

test("selection prefers default CLI, excludes sub-agents and ignores unrelated defaults", () => {
  const models = [model("wrong"), model("chosen")];
  const agents = [
    cli(["wrong"], { name: "worker", tags: ["cli", "default", "sub-agent"] }),
    cli(["wrong"], { name: "other", tags: ["default"] }),
    cli(["wrong"], { name: "secondary", tags: ["cli"] }),
    cli(["chosen"], { name: "primary" }),
  ];
  assert.deepEqual(ids(projectModels({ models, agents })), ["chosen"]);
  assert.deepEqual(ids(projectModels({ models, agents: [agents[2], { name: "cli", models: ["chosen"] }] })), ["wrong"]);
  assert.deepEqual(ids(projectModels({ models, agents: [{ name: "cli", models: ["chosen"] }] })), ["chosen"]);
});

test("agent references resolve ID before name before alias and deduplicate", () => {
  const models = [
    model("alias-target", { aliases: ["shared", "friendly"] }),
    model("name-target", { name: "shared" }), model("shared"),
  ];
  const agents = [cli(["shared", "friendly", "alias-target", "missing", "name-target"])];
  assert.deepEqual(ids(projectModels({ models, agents })), ["shared", "alias-target", "name-target"]);
  assert.deepEqual(ids(projectModels({ models: models.slice(0, 2), agents: [cli(["shared"])] })), ["name-target"]);
});

test("only official custom/chat additions extend the list, not craft modelTags", () => {
  const models = [model("primary"), model("hidden", { tags: ["craft"] }),
    model("extra-chat", { tags: ["chat"] }), model("extra-custom", { tags: ["custom"] }), model("custom:local")];
  assert.deepEqual(ids(projectModels({ models, agents: [cli(["primary", "extra-chat"], { modelTags: ["craft"] })] })),
    ["primary", "extra-chat", "extra-custom", "custom:local"]);
  assert.deepEqual(ids(projectModels({ models, agents: [cli([])] })), ["extra-chat", "extra-custom", "custom:local"]);
});

test("availableModels intersects the agent list rather than reopening the registry", () => {
  const models = [model("a"), model("b"), model("hidden")], agents = [cli(["b", "a"])];
  assert.deepEqual(ids(projectModels({ models, agents, availableModels: ["a", "hidden"] })), ["a"]);
  assert.deepEqual(ids(projectModels({ models, agents, availableModels: [] })), ["b", "a"]);
  assert.throws(() => projectModels({ models, agents, availableModels: ["hidden"] }),
    error => error.diagnosticCode === "catalog-filtered");
});

test("malformed agent selections fail closed, while absent agents keep legacy compatibility", () => {
  const models = [model("legacy")];
  for (const agents of [null, {}, [], [{ name: "unrelated", models: ["legacy"] }],
    [cli(["legacy"], { tags: ["cli", "sub-agent"] })],
    [cli(undefined)], [cli("legacy")], [cli([null])], [cli([""])], [cli(["x".repeat(257)])],
    [cli(Array(2001).fill("legacy"))], Array(2001).fill(cli(["legacy"]))]) {
    assert.throws(() => projectModels({ models, agents }), error => error.diagnosticCode === "catalog-shape");
  }
  for (const refs of [[], ["unknown"]]) {
    assert.throws(() => projectModels({ models, agents: [cli(refs)] }), error => error.diagnosticCode === "catalog-filtered");
  }
  assert.deepEqual(ids(projectModels({ models })), ["legacy"]);
});

test("agent selection retains endpoint, disabled, tool and regional filters", () => {
  const models = [model("good"), model("disabled", { disabled: true }), model("no-tools", { supportsToolCall: false }),
    model("url", { url: "https://attacker.example" }), model("key", { apiKey: "PRIVATE" }),
    model("protocol", { useCustomProtocol: true }), model("deepseek-synthetic-sg"),
    model("custom:external", { url: "https://attacker.example" })];
  const config = { models, agents: [cli(ids(models))] };
  assert.deepEqual(ids(projectModels(config, INTL_REGION)), ["good"]);
  assert.deepEqual(ids(projectModels(config, CN_REGION)), ["good", "deepseek-synthetic-sg"]);
});

test("generation models cannot enter the chat provider even when explicitly selected or chat-tagged", () => {
  const models = [model("good"),
    ...["text-to-image", "image-to-image", "text-to-video", "image-to-video"]
      .map((tag, i) => model("media-" + i, { tags: [tag, "chat"] })),
    model("video-config", { videoGeneration: { maxSeconds: 15 } })];
  assert.deepEqual(ids(projectModels({ models, agents: [cli(ids(models))] })), ["good"]);
  assert.deepEqual(ids(projectModels({ models })), ["good"]);
});

test("filtered diagnostics distinguish registry size, selected candidates and non-chat exclusions", () => {
  const config = { models: [model("hidden"), model("media", { tags: ["text-to-image"] })], agents: [cli(["media"])] };
  assert.throws(() => projectModels(config), error => {
    const message = describeFailure(error);
    assert.match(message, /total=2/);
    assert.match(message, /selected=1/);
    assert.match(message, /nonChat=1/);
    return error.diagnosticCode === "catalog-filtered";
  });
});

test("server additions/removals refresh and persist dynamically in both regions", async () => {
  for (const region of [INTL_REGION, CN_REGION]) {
    let config = { models: [model("old"), model("new"), model("retired")], agents: [cli(["old"])] };
    let persisted, calls = 0;
    const provider = createWorkbuddyProvider({ api, region, client: { async catalog() { calls++; return config; } } });
    const ctx = context(region, { async publish({ persist, update }) { persisted = persist; update(); return true; } });
    await provider.refreshModels(ctx);
    assert.deepEqual(ids(provider.getModels()), ["old"]);
    config = { ...config, agents: [cli(["new"])] };
    await provider.refreshModels(ctx);
    assert.equal(calls, 2);
    assert.deepEqual(ids(provider.getModels()), ["new"]);
    assert.deepEqual(ids(persisted.models), ["new"]);
    assert.deepEqual(ids(restoreCatalog(persisted, catalogCacheKey(credential(region), region), region)), ["new"]);
    assert.doesNotMatch(JSON.stringify(persisted), /SYNTHETIC|synthetic-user|agents|instructions|retired/);
    config = { ...config, agents: [cli(["missing-definition"])] };
    await assert.rejects(provider.refreshModels(ctx));
    assert.deepEqual(ids(provider.getModels()), ["new"], "bad refresh retains the last valid filtered catalog");
  }
});

test("old unfiltered caches are ignored offline and replaced by an online filtered catalog", async () => {
  for (const region of [INTL_REGION, CN_REGION]) {
    const config = mixedCatalog();
    const key = catalogCacheKey(credential(region), region);
    const legacy = catalogCacheEntry(projectModels({ models: [model("retired")] }, region), key);
    delete legacy.projectionVersion;
    for (const projectionVersion of [undefined, 0, 1, 3, "2"]) {
      assert.equal(restoreCatalog({ ...legacy, projectionVersion }, key, region), undefined);
    }
    let calls = 0, persisted;
    const provider = createWorkbuddyProvider({ api, region, client: { async catalog() { calls++; return config; } } });
    await provider.refreshModels(context(region, { allowNetwork: false, stored: legacy }));
    assert.equal(calls, 0);
    assert.equal(provider.getCatalogStatus().source, "fallback");
    assert.deepEqual(ids(provider.getModels()), ["default-model"]);
    await provider.refreshModels(context(region, { stored: legacy,
      async publish({ persist, update }) { persisted = persist; update(); return true; } }));
    assert.equal(calls, 1);
    assert.equal(provider.getCatalogStatus().source, "remote");
    assert.deepEqual(ids(provider.getModels()), config.agents[0].models);
    const restarted = createWorkbuddyProvider({ api, region, client: { async catalog() { throw new Error("Must stay offline"); } } });
    await restarted.refreshModels(context(region, { allowNetwork: false, stored: persisted }));
    assert.equal(restarted.getCatalogStatus().source, "cache");
    assert.deepEqual(ids(restarted.getModels()), config.agents[0].models);
  }
});

const dist = process.env.PI_AI_TEST_PATH;
const agentDist = process.env.PI_AGENT_TEST_PATH || (dist ? resolve(dist, "../../../../dist") : undefined);
test("Pi disk store preserves the projection version and restores only filtered models", {
  skip: !dist && "Set PI_AI_TEST_PATH to the installed pi-ai/dist directory",
}, async t => {
  const host = await import(pathToFileURL(join(dist, "index.js")).href);
  const { FileModelsStore } = await import(pathToFileURL(join(agentDist, "core/models-store.js")).href);
  const directory = await mkdtemp(join(tmpdir(), "pi-workbuddy-catalog-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "models-store.json");
  for (const region of [INTL_REGION, CN_REGION]) {
    const credentials = new host.InMemoryCredentialStore();
    await credentials.modify(region.id, async () => credential(region));
    const registry = host.createModels({ credentials, modelsStore: new FileModelsStore(path) });
    const config = mixedCatalog();
    registry.setProvider(createWorkbuddyProvider({ api, region, client: { async catalog() { return config; } } }));
    assert.equal((await registry.refresh({ providers: [region.id], allowNetwork: true, force: true })).errors.size, 0);
    const stored = await new FileModelsStore(path).read(region.id);
    assert.equal(stored.projectionVersion, 2);
    assert.deepEqual(ids(stored.models), config.agents[0].models);
    const restarted = host.createModels({ credentials, modelsStore: new FileModelsStore(path) });
    const provider = createWorkbuddyProvider({ api, region,
      client: { async catalog() { throw new Error("Must stay offline"); } } });
    restarted.setProvider(provider);
    assert.equal((await restarted.refresh({ providers: [region.id], allowNetwork: false })).errors.size, 0);
    assert.equal(provider.getCatalogStatus().source, "cache");
    assert.deepEqual(ids(restarted.getModels(region.id)), config.agents[0].models);
  }
});

test("Pi host publishes the filtered agent catalog and replaces it on refresh", {
  skip: !dist && "Set PI_AI_TEST_PATH to the installed pi-ai/dist directory",
}, async () => {
  const host = await import(pathToFileURL(join(dist, "index.js")).href);
  for (const region of [INTL_REGION, CN_REGION]) {
    const credentials = new host.InMemoryCredentialStore();
    await credentials.modify(region.id, async () => credential(region));
    const registry = host.createModels({ credentials });
    const config = mixedCatalog();
    registry.setProvider(createWorkbuddyProvider({ api, region, client: { async catalog() { return config; } } }));
    const refresh = () => registry.refresh({ providers: [region.id], allowNetwork: true, force: true });
    assert.equal((await refresh()).errors.size, 0);
    assert.deepEqual(ids(registry.getModels(region.id)), config.agents[0].models);
    config.agents[0].models = ["current-0"];
    assert.equal((await refresh()).errors.size, 0);
    assert.deepEqual(ids(registry.getModels(region.id)), ["current-0"]);
  }
});
