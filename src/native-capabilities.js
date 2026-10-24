// Reviewed public vendor specifications supplement live WorkBuddy metadata.
// These are optimistic capabilities, not entitlement checks or a model-ID allowlist.
const profiles = new Map();
function add(ids, profile) {
  for (const id of ids) profiles.set(id, Object.freeze({
    ...profile,
    ...(profile.efforts ? { efforts: Object.freeze([...profile.efforts]) } : {}),
  }));
}
const deepseek = {
  contextWindow: 1048576, maxOutputTokens: 393216, images: true, reasoning: true,
  efforts: ["low", "high", "max"],
  source: "https://api-docs.deepseek.com/quick_start/pricing",
};
add(["deepseek-v4.1-flash"], deepseek);
for (const id of ["gemini-3.5-flash", "gemini-3.8-flash"]) add([id], {
  contextWindow: 1048576, maxOutputTokens: 65536, images: true, reasoning: true,
  onlyReasoning: true,
  efforts: [...(id === "gemini-3.5-flash" ? ["minimal"] : []), "low", "medium", "high"],
  source: "https://ai.google.dev/gemini-api/docs/models/" + id,
});
for (const id of ["glm-5.2", "glm-5.3", "glm-5.3-flash"]) add([id], {
  // Vendor docs publish rounded 1M; retain larger exact values advertised by WorkBuddy.
  contextWindow: 1000000, maxOutputTokens: 131072, images: id === "glm-5.3-flash", reasoning: true,
  onlyReasoning: id !== "glm-5.2",
  efforts: id === "glm-5.2" ? ["minimal", "low", "medium", "high", "xhigh", "max"] : ["low", "high", "max"],
  off: "none", source: "https://docs.z.ai/guides/llm/" + id,
});
for (const id of ["gpt-5.4", "gpt-5.5", "gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra",
  "gpt-6-astra", "gpt-6-luna", "gpt-6-sol", "gpt-6.1-sol"]) add([id], {
  contextWindow: 1050000, maxOutputTokens: 128000, images: true, reasoning: true,
  efforts: ["low", "medium", "high", "xhigh", ...(["gpt-5.4", "gpt-5.5"].includes(id) ? [] : ["max"])],
  onlyReasoning: ["gpt-6-astra", "gpt-6.1-sol"].includes(id), off: "none",
  source: "https://developers.openai.com/api/docs/models/" + id,
});
add(["grok-4.7"], {
  contextWindow: 500000, images: true, reasoning: true, onlyReasoning: true,
  // "No text output limit" is not a finite output number; keep WorkBuddy's numeric value.
  efforts: ["low", "medium", "high", "xhigh"], source: "https://docs.x.ai/developers/grok-4-7",
});
add(["hy3"], {
  contextWindow: 256000, maxOutputTokens: 128000, reasoning: true, efforts: ["low", "high"], off: "none",
  source: "https://intl.cloud.tencent.com/ind/document/product/1300/80695",
});
add(["hy4-preview"], {
  contextWindow: 1000000, maxOutputTokens: 64000, reasoning: true, efforts: ["high"], off: "none",
  source: "https://intl.cloud.tencent.com/ind/document/product/1300/80695",
});
add(["kimi-k2.6"], {
  contextWindow: 262144, maxOutputTokens: 262144, images: true, reasoning: true,
  // K2.6 uses thinking.type, not reasoning_effort. Its output shares the context window.
  thinkingFormat: "deepseek", supportsReasoningEffort: false,
  source: "https://platform.kimi.ai/docs/api/models-overview",
});
add(["kimi-k2.8-preview"], {
  // Official Kimi Code docs name K2.8 Preview but expose it as kimi-for-coding.
  // Use that named-model reference optimistically; no published finite output cap.
  contextWindow: 1048576, reasoning: true, efforts: ["low", "high", "max"],
  source: "https://www.kimi.com/code/docs/en/kimi-code/models",
});
add(["kimi-k3"], {
  contextWindow: 1048576, maxOutputTokens: 1048576, images: true, reasoning: true, onlyReasoning: true,
  // This is the accepted completion-parameter ceiling, not additional independent context.
  efforts: ["low", "high", "max"], source: "https://platform.kimi.ai/docs/guide/kimi-k3-quickstart",
});
add(["minimax-m3.1-flash"], {
  contextWindow: 1000000, maxOutputTokens: 524288, images: true, reasoning: true, onlyReasoning: true,
  efforts: ["low", "medium", "high", "xhigh", "max"],
  source: "https://platform.minimax.io/docs/guides/models-intro",
});
add(["step-5-preview"], {
  contextWindow: 1000000, maxOutputTokens: 64000, images: true, reasoning: true,
  efforts: ["low", "medium", "high"], source: "https://platform.stepfun.ai/docs/en/guides/models/step-5-preview",
});

export function getVendorCapabilities(id) {
  return profiles.get(id);
}

export function vendorCapabilityIds() {
  return [...profiles.keys()];
}
