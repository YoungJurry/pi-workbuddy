const FALLBACK_CONTEXT = 32768;
const FALLBACK_OUTPUT = 4096;
export const isTokenLimit = value => Number.isSafeInteger(value) && value > 0;

/** Use the largest advertised/documented budget, not a smaller configured default. */
export function resolveTokenLimits(item, vendor = {}) {
  const supported = Array.isArray(item.contextWindow?.supportedLengths) ? item.contextWindow.supportedLengths : [];
  const contexts = [item.maxInputTokens, item.contextWindow?.defaultLength, ...supported, vendor.contextWindow].filter(isTokenLimit);
  const contextWindow = contexts.reduce((maximum, value) => Math.max(maximum, value), 0) || FALLBACK_CONTEXT;
  const outputs = [item.maxOutputTokens, vendor.maxOutputTokens].filter(isTokenLimit);
  // Input and output still share Pi's context budget; never add them together.
  const maxTokens = Math.min(outputs.length ? Math.max(...outputs) : FALLBACK_OUTPUT, contextWindow);
  // maxAllowedSize remains excluded because its units are not established.
  return { contextWindow, maxTokens };
}

export function resolveOutputLimit(model, requested) {
  if (requested !== undefined && !isTokenLimit(requested)) {
    throw new Error("WorkBuddy maxTokens must be a positive safe integer.");
  }
  if (!isTokenLimit(model.maxTokens) || !isTokenLimit(model.contextWindow)) {
    throw new Error("WorkBuddy model token limits are invalid; refresh the model catalog.");
  }
  return Math.min(requested ?? model.maxTokens, model.maxTokens, model.contextWindow);
}

/** Apply after caller payload hooks so sampling parameters cannot silently bypass the output cap. */
export function capPayloadOutput(payload, outputLimit) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("WorkBuddy chat payload must be an object.");
  }
  const fields = ["max_tokens", "max_completion_tokens"];
  let limit = outputLimit;
  for (const field of fields) {
    if (payload[field] === undefined) continue;
    if (!isTokenLimit(payload[field])) throw new Error("WorkBuddy " + field + " must be a positive safe integer.");
    limit = Math.min(limit, payload[field]);
  }
  // The inspected WorkBuddy wire format uses max_tokens, not max_completion_tokens.
  const result = { ...payload, max_tokens: limit };
  delete result.max_completion_tokens;
  return result;
}
