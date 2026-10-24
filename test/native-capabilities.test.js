import assert from "node:assert/strict";
import { test } from "node:test";
import { getVendorCapabilities, vendorCapabilityIds } from "../src/native-capabilities.js";
import { projectModels } from "../src/native-models.js";
import { resolveTokenLimits } from "../src/native-limits.js";

const expected = [
  ["deepseek-v4.1-flash", 1048576, 393216, true],
  ["gemini-3.5-flash", 1048576, 65536, true],
  ["gemini-3.8-flash", 1048576, 65536, true],
  ["glm-5.2", 1000000, 131072, false],
  ["glm-5.3", 1000000, 131072, false],
  ["glm-5.3-flash", 1000000, 131072, true],
  ...["gpt-5.4", "gpt-5.5", "gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra",
    "gpt-6-astra", "gpt-6-luna", "gpt-6-sol", "gpt-6.1-sol"].map(id => [id, 1050000, 128000, true]),
  ["grok-4.7", 500000, 4096, true], // No invented finite vendor output maximum.
  ["hy3", 256000, 128000, false],
  ["hy4-preview", 1000000, 64000, false],
  ["kimi-k2.6", 262144, 262144, true], // Shared context-dependent maximum.
  ["kimi-k2.8-preview", 1048576, 4096, false], // Unpublished fields stay catalog-derived.
  ["kimi-k3", 1048576, 1048576, true], // Completion-parameter ceiling, shared context.
  ["minimax-m3.1-flash", 1000000, 524288, true],
  ["step-5-preview", 1000000, 64000, true],
];
for (const [id, contextWindow, maxTokens, images] of expected) {
  test("vendor capabilities: " + id, () => {
    const [model] = projectModels({ models: [{ id, maxInputTokens: 16000, maxOutputTokens: 4096 }] });
    assert.equal(model.contextWindow, contextWindow);
    assert.equal(model.maxTokens, maxTokens);
    assert.deepEqual(model.input, images ? ["text", "image"] : ["text"]);
    assert.equal(model.reasoning, true);
    assert.match(getVendorCapabilities(id).source, /^https:\/\//);
  });
}

test("all 23 named models have reviewed references; four routing aliases remain live", () => {
  assert.deepEqual(vendorCapabilityIds().sort(), expected.map(row => row[0]).sort());
  for (const id of ["default-model", "fast-model", "balanced-model", "primary-model", "future-model-v999", "__proto__", "toString", "deepseek-v4.1-flash-unknown"]) {
    assert.equal(getVendorCapabilities(id), undefined);
    const [model] = projectModels({ models: [{ id, supportsReasoning: true, supportsImages: true,
      maxInputTokens: 900000, maxOutputTokens: 64000, contextWindow: { defaultLength: 300000, supportedLengths: [300000, 1200000] },
      reasoning: { supportedEfforts: ["low", "max"] } }] });
    assert.equal(model.contextWindow, 1200000);
    assert.equal(model.maxTokens, 64000);
    assert.equal(model.thinkingLevelMap.max, "max");
    assert.deepEqual(model.input, ["text", "image"]);
  }
});

test("DeepSeek exposes screenshot's low/high/max and does not stick to 300K", () => {
  const [model] = projectModels({ models: [{ id: "deepseek-v4.1-flash", maxInputTokens: 1000000,
    maxOutputTokens: 128000, onlyReasoning: true, contextWindow: { supportedLengths: [300000, 1000000], defaultLength: 300000 } }] });
  assert.equal(model.contextWindow, 1048576);
  assert.equal(model.maxTokens, 393216);
  assert.deepEqual(model.thinkingLevelMap, { off: null, minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: "max" });
});

test("capabilities are additive: vendor omissions and smaller limits never shrink live metadata", () => {
  const [model] = projectModels({ models: [{ id: "glm-5.3", supportsImages: true,
    maxInputTokens: 2000000, maxOutputTokens: 200000, reasoning: { supportedEfforts: ["medium", "xhigh"] } }] });
  assert.deepEqual(model.input, ["text", "image"]); // Gateway may provide image preprocessing.
  assert.equal(model.contextWindow, 2000000);
  assert.equal(model.maxTokens, 200000);
  assert.equal(model.thinkingLevelMap.medium, "medium");
  assert.equal(model.thinkingLevelMap.xhigh, "xhigh");
  assert.equal(model.thinkingLevelMap.max, "max");
  const [vendorImage] = projectModels({ models: [{ id: "deepseek-v4.1-flash", supportsImages: false, disabledMultimodal: true }] });
  assert.deepEqual(vendorImage.input, ["text", "image"]);
});

test("invalid limits and malformed efforts do not suppress vendor capabilities", () => {
  const [model] = projectModels({ models: [{ id: "deepseek-v4.1-flash", maxInputTokens: "1000000",
    maxOutputTokens: Infinity, reasoning: { supportedEfforts: { filter: "not callable" } } }] });
  assert.equal(model.contextWindow, 1048576);
  assert.equal(model.thinkingLevelMap.max, "max");
  assert.deepEqual(resolveTokenLimits({ contextWindow: { supportedLengths: Array(150000).fill(1000000) } }),
    { contextWindow: 1000000, maxTokens: 4096 });
});

test("mandatory reasoning and effort-specific compatibility stay model-specific", () => {
  const project = id => projectModels({ models: [{ id }] })[0];
  assert.equal(project("gpt-5.4").thinkingLevelMap.xhigh, "xhigh");
  assert.equal(project("gpt-5.4").thinkingLevelMap.max, null);
  assert.equal(project("gpt-5.4").thinkingLevelMap.off, "none");
  assert.equal(project("gpt-6-astra").thinkingLevelMap.off, null);
  assert.equal(project("gpt-6-astra").thinkingLevelMap.max, "max");
  assert.equal(project("gemini-3.5-flash").thinkingLevelMap.minimal, "minimal");
  assert.equal(project("gemini-3.8-flash").thinkingLevelMap.minimal, null);
  assert.equal(project("kimi-k2.6").compat.supportsReasoningEffort, false);
  assert.equal(project("kimi-k2.6").compat.thinkingFormat, "deepseek");
});

test("DeepSeek -sg variants are excluded without hiding regular or unrelated models", () => {
  const excluded = ["deepseek-v4.1-flash-sg", "deepseek-future-v9-sg", "DEEPSEEK-V9-SG", "deepseek-sg"];
  const kept = ["deepseek-v4.1-flash", "deepseek-future-v9", "hy3-sg", "deepseek-v4.1-flash-sg-preview"];
  const models = projectModels({ models: [...excluded, ...kept].map(id => ({ id, supportsToolCall: true })) });
  assert.deepEqual(models.map(model => model.id), kept);
  assert.equal(models[0].contextWindow, 1048576);
  assert.equal(models[0].thinkingLevelMap.max, "max");
  assert.equal(getVendorCapabilities("deepseek-v4.1-flash-sg"), undefined);
  assert.throws(() => projectModels({ models: excluded.map(id => ({ id })) }), error => {
    assert.equal(error.diagnosticCode, "catalog-filtered");
    assert.equal(error.details.excluded, excluded.length);
    return true;
  });
});
