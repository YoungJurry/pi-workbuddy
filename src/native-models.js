import { INTL_REGION } from "./regions.js";
import { WorkbuddyError } from "./native-errors.js";
import { resolveTokenLimits } from "./native-limits.js";
import { getVendorCapabilities } from "./native-capabilities.js";
const COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"];
const validId = value => typeof value === "string" && value.length <= 256 && /^[\w./:-]+$/.test(value);

// Match the official CLI's default-agent selection and computeModelsFromRaw().
// models is a definition registry, not the list offered by the current agent.
function selectAgentModels(config) {
  // Older catalogs (and public-metadata cache reprojection) have no agents.
  if (config.agents === undefined) return config.models;
  if (!Array.isArray(config.agents) || config.agents.length > 2000) {
    throw new WorkbuddyError("catalog-shape", "Invalid WorkBuddy agent catalog.");
  }
  const hasTag = (item, tag) => Array.isArray(item?.tags) && item.tags.includes(tag);
  const cli = config.agents.filter(agent => hasTag(agent, "cli") && !hasTag(agent, "sub-agent"));
  const agent = cli.find(agent => hasTag(agent, "default")) ?? cli[0] ??
    config.agents.find(agent => agent?.name === "cli" && !hasTag(agent, "sub-agent"));
  if (!Array.isArray(agent?.models) || agent.models.length > 2000 ||
    agent.models.some(ref => typeof ref !== "string" || !ref || ref.length > 256)) {
    // Do not widen an empty/broken agent catalog back to the full registry.
    throw new WorkbuddyError("catalog-shape", "WorkBuddy returned no valid CLI agent model list.");
  }
  const selected = [], seen = new Set();
  const append = model => {
    if (model && !seen.has(model.id)) { selected.push(model); seen.add(model.id); }
  };
  for (const ref of agent.models) {
    append(config.models.find(model => model?.id === ref) ??
      config.models.find(model => model?.name === ref) ??
      config.models.find(model => Array.isArray(model?.aliases) && model.aliases.includes(ref)));
  }
  // Official CLI also appends custom/chat models. Endpoint checks below still apply.
  // modelTags alone does not extend this list in the verified CLI 2.161.0 code.
  for (const model of config.models) {
    if (hasTag(model, "custom") || (typeof model?.id === "string" && model.id.startsWith("custom:")) ||
      hasTag(model, "chat")) append(model);
  }
  return selected;
}

export function projectModels(config, region = INTL_REGION) {
  if (!Array.isArray(config?.models) || config.models.length > 2000) {
    throw new WorkbuddyError("catalog-shape", "Invalid WorkBuddy model catalog.");
  }
  const available = Array.isArray(config.availableModels) && config.availableModels.length ? new Set(config.availableModels) : undefined;
  const seen = new Set();
  const models = [];
  const candidates = selectAgentModels(config);
  const counts = { total: config.models.length, selected: candidates.length, accepted: 0, invalid: 0, duplicate: 0,
    disabled: 0, toolLess: 0, nonChat: 0, endpoint: 0, unavailable: 0, excluded: 0 };
  for (const item of candidates) {
    // Report only counts, never model URLs, API keys, remote instructions, or full catalog bodies.
    if (!validId(item?.id)) { counts.invalid++; continue; }
    const normalizedId = item.id.toLowerCase();
    if (region.excludeSg && normalizedId.startsWith("deepseek-") && normalizedId.endsWith("-sg")) { counts.excluded++; continue; }
    if (seen.has(item.id)) { counts.duplicate++; continue; }
    if (item.disabled === true) { counts.disabled++; continue; }
    if (item.supportsToolCall === false) { counts.toolLess++; continue; }
    if (item.videoGeneration || (Array.isArray(item.tags) && item.tags.some(tag =>
      ["text-to-image", "image-to-image", "text-to-video", "image-to-video"].includes(tag)))) {
      counts.nonChat++; continue;
    }
    if (item.url || item.apiKey || item.useCustomProtocol) { counts.endpoint++; continue; }
    if (available && !available.has(item.id)) { counts.unavailable++; continue; }
    seen.add(item.id);
    const vendor = getVendorCapabilities(item.id) ?? {};
    const { contextWindow, maxTokens } = resolveTokenLimits(item, vendor);
    const reasoning = item.supportsReasoning === true || vendor.reasoning === true;
    const catalogEfforts = Array.isArray(item.reasoning?.supportedEfforts) ? item.reasoning.supportedEfforts : [];
    const efforts = [...new Set([...catalogEfforts, ...(vendor.efforts ?? [])].filter(effort => LEVELS.includes(effort)))];
    const onlyReasoning = item.onlyReasoning === true || item.reasoning?.canDisableThinking === false || vendor.onlyReasoning === true;
    const thinkingLevelMap = reasoning ? {
      ...(onlyReasoning ? { off: null } : vendor.off ? { off: vendor.off } : {}),
      ...(efforts?.length ? Object.fromEntries(LEVELS.map(level => [level, efforts.includes(level) ? level : null])) : {}),
    } : undefined;
    models.push({
      id: item.id, name: typeof item.name === "string" ? item.name.slice(0, 256) : item.id,
      provider: region.id, api: "openai-completions", baseUrl: region.baseUrl,
      // Prefer availability: retain gateway image support even when the vendor is text-only,
      // and expose vendor-advertised image support even if gateway metadata omits/disables it.
      reasoning, input: item.supportsImages === true || vendor.images === true ? ["text", "image"] : ["text"],
      cost: { ...COST }, contextWindow, maxTokens,
      ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
      samplingParams: {
        ...(Number.isFinite(item.temperature) ? { temperature: item.temperature } : {}),
        ...(Number.isFinite(item.top_p) ? { top_p: item.top_p } : {}),
      },
      // Observed in the shipped SDK: system role and max_tokens; never infer from model names.
      compat: { supportsDeveloperRole: false, maxTokensField: "max_tokens", supportsStore: false,
        supportsReasoningEffort: reasoning && (vendor.supportsReasoningEffort !== false || catalogEfforts.length > 0),
        ...(vendor.thinkingFormat ? { thinkingFormat: vendor.thinkingFormat } : {}),
      },
    });
  }
  if (!models.length) throw new WorkbuddyError(config.models.length ? "catalog-filtered" : "catalog-empty",
    "WorkBuddy returned no supported tool-capable models. Existing catalog retained.", counts);
  return models;
}

export function fallbackModels(region = INTL_REGION) {
  return projectModels({ models: [{ id: "default-model", name: region.fallbackName, maxInputTokens: 32768, maxOutputTokens: 4096 }] }, region);
}
