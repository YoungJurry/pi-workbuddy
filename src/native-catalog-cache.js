import { createHash } from "node:crypto";
import { INTL_REGION } from "./regions.js";
import { projectModels } from "./native-models.js";
import { WorkbuddyError } from "./native-errors.js";

/** Local cache validator only; never sent as an HTTP ETag. Tokens are not hashed or stored. */
export function catalogCacheKey(credential, region = INTL_REGION) {
  if (credential?.type !== "oauth" || credential.origin !== region.origin || !credential.userId ||
    (credential.domain && !region.accountDomains.includes(credential.domain))) return undefined;
  const parts = [region.origin, credential.userId, credential.domain || region.domain, credential.enterpriseId || ""];
  if (parts.some(value => typeof value !== "string" || value.length > 2048 || /[\r\n\0]/.test(value))) return undefined;
  return "workbuddy-catalog-v1:" + createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

/** Reproject a public metadata whitelist, never cached auth, endpoints, headers or instructions. */
export function restoreCatalog(entry, key, region = INTL_REGION) {
  if (!key || entry?.etag !== key) return undefined;
  if (!Array.isArray(entry.models) || entry.models.length > 2000) {
    throw new WorkbuddyError("catalog-cache", "Cached WorkBuddy model metadata is invalid.");
  }
  const models = entry.models.filter(model => model?.provider === region.id && model.api === "openai-completions" &&
    model.baseUrl === region.baseUrl).map(model => ({
    id: model.id, name: model.name,
    maxInputTokens: model.contextWindow, maxOutputTokens: model.maxTokens,
    supportsReasoning: model.reasoning === true,
    supportsImages: Array.isArray(model.input) && model.input.includes("image"),
    onlyReasoning: model.thinkingLevelMap?.off === null,
    reasoning: { supportedEfforts: model.thinkingLevelMap && typeof model.thinkingLevelMap === "object" ?
      Object.entries(model.thinkingLevelMap).filter(([level, value]) => level !== "off" && typeof value === "string").map(([level]) => level) : [] },
    temperature: model.samplingParams?.temperature, top_p: model.samplingParams?.top_p,
  }));
  try { return projectModels({ models }, region); }
  catch { throw new WorkbuddyError("catalog-cache", "Cached WorkBuddy model metadata is invalid."); }
}

export function catalogCacheEntry(models, key) {
  // Models originate from projectModels(), which emits only bounded public metadata.
  return { models, checkedAt: Date.now(), etag: key };
}
