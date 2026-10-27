import assert from "node:assert/strict";
import { test } from "node:test";
import { catalogCacheKey, catalogCacheEntry, restoreCatalog } from "../src/native-catalog-cache.js";
import { createWorkbuddyProvider } from "../src/native-provider.js";
import { projectModels } from "../src/native-models.js";

const credential = () => ({ type: "oauth", origin: "https://www.workbuddy.ai", userId: "mock-user",
  access: "SYNTHETIC_ACCESS", refresh: "SYNTHETIC_REFRESH", expires: Date.now() + 3600000 });
const models = () => projectModels({ models: [{ id: "deepseek-v4.1-flash", supportsToolCall: true }, { id: "default-model", name: "Default", maxInputTokens: 176000 }] });
const entry = () => catalogCacheEntry(models(), catalogCacheKey(credential()));
const api = { stream() { throw new Error("Inference prohibited"); }, streamSimple() { throw new Error("Inference prohibited"); } };
const context = extra => ({ credential: credential(), allowNetwork: false, force: true, signal: new AbortController().signal,
  async publish({ update }) { update(); return true; }, ...extra });

test("cache identity is account/domain/tenant scoped and independent of tokens", () => {
  const key = catalogCacheKey(credential());
  assert.match(key, /^workbuddy-catalog-v1:[a-f0-9]{64}$/);
  assert.equal(key, catalogCacheKey({ ...credential(), access: "ROTATED", refresh: "ROTATED_REFRESH" }));
  assert.equal(key, catalogCacheKey({ ...credential(), domain: "www.workbuddy.ai" }));
  for (const change of [{ userId: "other-user" }, { domain: "workbuddy.ai" }, { enterpriseId: "other-tenant" }]) {
    assert.notEqual(key, catalogCacheKey({ ...credential(), ...change }));
  }
  for (const value of [undefined, {}, { ...credential(), origin: "https://evil.example" }, { ...credential(), userId: "bad\nvalue" }]) {
    assert.equal(catalogCacheKey(value), undefined);
  }
  assert.doesNotMatch(JSON.stringify(entry()), /SYNTHETIC_ACCESS|SYNTHETIC_REFRESH|mock-user/);
});

test("cache restoration reprojects capabilities and removes SG and untrusted fields", () => {
  const stored = entry();
  stored.models.unshift({ ...stored.models[0], id: "deepseek-v4.1-flash-sg" });
  stored.models[1] = { ...stored.models[1], headers: { Authorization: "PRIVATE" }, prompts: ["PRIVATE"], cost: { input: 100000 } };
  stored.models.push({ ...stored.models[1], id: "external", baseUrl: "https://evil.example" });
  const result = restoreCatalog(stored, catalogCacheKey(credential()));
  assert.deepEqual(result.map(model => model.id), ["deepseek-v4.1-flash", "default-model"]);
  assert.equal(result[0].contextWindow, 1048576);
  assert.equal(result[0].thinkingLevelMap.max, "max");
  assert.equal(result[0].cost.input, 0);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|evil\.example|prompts/);
  assert.equal(restoreCatalog(stored, "wrong-account"), undefined);
  assert.throws(() => restoreCatalog({ ...stored, models: Array(2001).fill(stored.models[0]) }, stored.etag),
    error => error.diagnosticCode === "catalog-cache");
});

test("new provider instances restore an offline catalog without network or inference", async () => {
  let calls = 0;
  const provider = createWorkbuddyProvider({ api, client: { async catalog() { calls++; throw new Error("Must remain offline"); } } });
  await provider.refreshModels(context({ stored: entry() }));
  assert.equal(calls, 0);
  assert.equal(provider.getCatalogStatus().source, "cache");
  assert.deepEqual(provider.getModels().map(model => model.id), ["deepseek-v4.1-flash", "default-model"]);
});

test("remote publication persists only projected metadata and never raw server fields", async () => {
  let persisted;
  const provider = createWorkbuddyProvider({ api, client: { async catalog() {
    return { models: [{ id: "fresh", supportsToolCall: true, description: "PRIVATE", extraHeaders: { Authorization: "PRIVATE" } }], prompts: ["PRIVATE"] };
  } } });
  await provider.refreshModels(context({ allowNetwork: true, async publish({ persist, update }) { persisted = persist; update(); return true; } }));
  assert.equal(provider.getCatalogStatus().source, "remote");
  assert.equal(persisted.models[0].id, "fresh");
  assert.ok(Number.isSafeInteger(persisted.checkedAt));
  assert.doesNotMatch(JSON.stringify(persisted), /PRIVATE|SYNTHETIC|mock-user|extraHeaders|description|prompts/);
});

test("failed online refresh retains restored models and the error message", async () => {
  const provider = createWorkbuddyProvider({ api, client: { async catalog() { throw new Error("PRIVATE_TOKEN"); } } });
  await assert.rejects(provider.refreshModels(context({ allowNetwork: true, stored: entry() })));
  assert.equal(provider.getCatalogStatus().source, "cache");
  assert.equal(provider.getModels()[0].id, "deepseek-v4.1-flash");
  assert.equal(provider.getCatalogStatus().lastError, "PRIVATE_TOKEN");
});

test("malformed and obsolete SG-only caches cannot block online recovery", async () => {
  for (const stored of [{ ...entry(), models: [] }, { ...entry(), models: [{ ...models()[0], id: "deepseek-v4.1-flash-sg" }] }]) {
    let calls = 0;
    const provider = createWorkbuddyProvider({ api, client: { async catalog() { calls++; return { models: [{ id: "recovered" }] }; } } });
    await provider.refreshModels(context({ allowNetwork: true, stored }));
    assert.equal(calls, 1);
    assert.equal(provider.getModels()[0].id, "recovered");
    assert.equal(provider.getCatalogStatus().lastError, undefined);
  }
});

test("rejected generation cannot install a restored cache or start an obsolete fetch", async () => {
  const provider = createWorkbuddyProvider({ api, client: { async catalog() { throw new Error("Must not fetch"); } } });
  await provider.refreshModels(context({ allowNetwork: true, stored: entry(), async publish() { return false; } }));
  assert.equal(provider.getCatalogStatus().source, "fallback");
  assert.equal(provider.getModels()[0].name, "WorkBuddy Default (fallback)");
});

test("logout and account changes do not reuse another account's catalog", async () => {
  for (const changed of [undefined, { ...credential(), userId: "other-user" }]) {
    const provider = createWorkbuddyProvider({ api });
    await provider.refreshModels(context({ stored: entry() }));
    assert.equal(provider.getCatalogStatus().source, "cache");
    await provider.refreshModels(context({ stored: entry(), credential: changed }));
    assert.equal(provider.getCatalogStatus().source, "fallback");
    assert.equal(provider.getModels()[0].name, "WorkBuddy Default (fallback)");
  }
});
