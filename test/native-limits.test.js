import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveTokenLimits, resolveOutputLimit, capPayloadOutput } from "../src/native-limits.js";
import { projectModels } from "../src/native-models.js";
import { createWorkbuddyProvider } from "../src/native-provider.js";

const cases = [
  ["maxAllowedSize must not inflate the input budget", { maxInputTokens: 176000, maxAllowedSize: 200000, maxOutputTokens: 24000 }, 176000, 24000],
  ["largest advertised context replaces DeepSeek's smaller default", { maxInputTokens: 1000000, maxOutputTokens: 128000, contextWindow: { defaultLength: 300000, supportedLengths: [300000, 1000000] } }, 1000000, 128000],
  ["advertised context default may exceed the input field", { maxInputTokens: 64000, maxOutputTokens: 8000, contextWindow: { defaultLength: 1000000 } }, 1000000, 8000],
  ["largest supported choice wins over an unsupported default", { maxInputTokens: 128000, contextWindow: { defaultLength: 96000, supportedLengths: [128000, 64000] } }, 128000, 4096],
  ["supported context is not truncated to a smaller input field", { maxInputTokens: 64000, contextWindow: { defaultLength: 128000, supportedLengths: [128000, 64000] } }, 128000, 4096],
  ["standalone smaller default cannot shrink the maximum", { maxInputTokens: 1000000, contextWindow: { defaultLength: 192000 } }, 1000000, 4096],
  ["output maximum is not added to the context budget", { maxInputTokens: 64000, maxOutputTokens: 16000 }, 64000, 16000],
  ["output cannot exceed context", { maxInputTokens: 8192, maxOutputTokens: 128000 }, 8192, 8192],
  ["unknown maxAllowedSize units do not create a token budget", { maxAllowedSize: 1000000 }, 32768, 4096],
  ["standalone advertised context does not get a fallback ceiling", { contextWindow: { defaultLength: 1000000 } }, 1000000, 4096],
  ["small advertised default is used when nothing else is known", { contextWindow: { defaultLength: 8192 } }, 8192, 4096],
  ["supported list can supply a budget without maxInputTokens", { contextWindow: { supportedLengths: [64000, 128000], defaultLength: 128000 } }, 128000, 4096],
  ["malformed supported list is ignored", { maxInputTokens: 64000, contextWindow: { supportedLengths: "128000" } }, 64000, 4096],
  ["invalid numeric values are ignored", { maxInputTokens: "128000", maxOutputTokens: -1, contextWindow: { defaultLength: NaN, supportedLengths: [null, 0, -1, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1] } }, 32768, 4096],
];
for (const [name, metadata, contextWindow, maxTokens] of cases) {
  test("token limits: " + name, () => {
    assert.deepEqual(resolveTokenLimits(metadata), { contextWindow, maxTokens });
    const projected = projectModels({ models: [{ id: "synthetic-model", ...metadata }] })[0];
    assert.equal(projected.contextWindow, contextWindow);
    assert.equal(projected.maxTokens, maxTokens);
  });
}

test("output cap validates caller limits and respects the model ceiling", () => {
  const model = { contextWindow: 64000, maxTokens: 8000 };
  assert.equal(resolveOutputLimit(model), 8000);
  assert.equal(resolveOutputLimit(model, 2000), 2000);
  assert.equal(resolveOutputLimit(model, 128000), 8000);
  for (const value of [0, -1, 1.5, NaN, Infinity, "4096", Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => resolveOutputLimit(model, value), /positive safe integer/);
  }
});

test("payload output cap uses max_tokens and respects smaller requests", () => {
  assert.deepEqual(capPayloadOutput({ max_tokens: 128000, stream: true }, 8000), { max_tokens: 8000, stream: true });
  assert.deepEqual(capPayloadOutput({ max_completion_tokens: 2000 }, 8000), { max_tokens: 2000 });
  assert.deepEqual(capPayloadOutput({}, 8000), { max_tokens: 8000 });
  assert.throws(() => capPayloadOutput({ max_tokens: 0 }, 8000), /positive safe integer/);
});

test("both provider entry points enforce output limits after sampling and caller hooks", async () => {
  let captured;
  const api = { stream(...args) { captured = args; return "stream"; }, streamSimple(...args) { captured = args; return "simple"; } };
  const provider = createWorkbuddyProvider({ api });
  const model = { ...provider.getModels()[0], contextWindow: 64000, maxTokens: 8000, samplingParams: { max_tokens: 4000, temperature: 0.5 } };
  for (const method of ["stream", "streamSimple"]) {
    provider[method](model, {}, {
      maxTokens: 128000, samplingParams: { max_completion_tokens: 100000, top_p: 0.9 },
      onPayload(payload) { payload.max_tokens = 900000; return { ...payload, max_completion_tokens: 800000, custom: "preserved" }; },
    });
    assert.equal(captured[2].maxTokens, 4000);
    assert.deepEqual(captured[0].samplingParams, { temperature: 0.5 });
    assert.deepEqual(captured[2].samplingParams, { top_p: 0.9 });
    // Simulate Pi reducing the output budget further to fit the remaining context.
    const result = await captured[2].onPayload({ max_tokens: 1500 }, captured[0]);
    assert.equal(result.max_tokens, 1500);
    assert.equal(result.max_completion_tokens, undefined);
    assert.equal(result.custom, "preserved");
  }
  assert.equal(model.samplingParams.max_tokens, 4000, "caller-owned metadata must not be mutated");
});
