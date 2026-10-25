// Adapted from lutfi238/pi-workbuddy@0.2.4 (MIT). See THIRD_PARTY_NOTICES.md.
import { describeFailure } from "./native-errors.js";

function definition(model) {
  return JSON.stringify([model?.provider, model?.id, model?.name, model?.contextWindow,
    model?.maxTokens, model?.reasoning, model?.input, model?.thinkingLevelMap]);
}

export async function recoverSelectedModel(pi, provider, ctx, selected = ctx.model) {
  if (!selected || selected.provider !== "workbuddy" || ctx.model !== selected || ctx.isIdle?.() === false) return;
  let previousId = selected.id;
  const placeholder = selected.name === "WorkBuddy Default (fallback)";
  if (placeholder) {
    const previous = ctx.sessionManager?.getBranch?.().findLast(entry => entry.type === "model_change");
    if (previous?.provider === "workbuddy" && typeof previous.modelId === "string") previousId = previous.modelId;
  }
  const id = /^deepseek-/i.test(previousId) && /-sg$/i.test(previousId) ? previousId.slice(0, -3) : previousId;
  const replacement = provider.getModels().find(model => model.id === id) ??
    (placeholder ? provider.getModels().find(model => model.id === selected.id) : undefined);
  if (!replacement || definition(selected) === definition(replacement)) return;
  if (await pi.setModel(replacement) === false) {
    ctx.ui?.notify?.("WorkBuddy catalog is ready; select an available model with /model.", "warning");
  }
}

export async function refreshWorkbuddyCatalog(pi, provider, ctx, signal = ctx.signal) {
  if (signal?.aborted) return false;
  const selected = ctx.model;
  try {
    const result = await ctx.modelRegistry.refresh({
      providers: ["workbuddy"], force: true, signal,
      ...(process.env.PI_OFFLINE !== undefined ? { allowNetwork: false } : {}),
    });
    if (result.aborted || signal?.aborted) return false;
    if (result.errors.has("workbuddy")) throw result.errors.get("workbuddy");
    await recoverSelectedModel(pi, provider, ctx, selected);
    return true;
  } catch (error) {
    if (!signal?.aborted) {
      ctx.ui?.notify?.("WorkBuddy catalog refresh failed: " + describeFailure(error) +
        " Cached models, if available, were retained. Use /workbuddy refresh to retry. No chat request sent.", "warning");
    }
    return false;
  }
}

/** No agent_end/message_end/model_select/context/provider-request handlers. */
export function registerNativeLifecycle(pi, provider) {
  let activeRefresh;
  const cancelRefresh = () => {
    activeRefresh?.abort();
    activeRefresh = undefined;
  };

  pi.on("session_start", (_event, ctx) => {
    cancelRefresh();
    if (!ctx.modelRegistry.hasConfiguredAuth(provider.getModels()[0])) return;
    const controller = new AbortController();
    activeRefresh = controller;
    const signal = ctx.signal ? AbortSignal.any([ctx.signal, controller.signal]) : controller.signal;
    const refresh = refreshWorkbuddyCatalog(pi, provider, ctx, signal).finally(() => {
      if (activeRefresh === controller) activeRefresh = undefined;
    });
    // Headless callers still wait for discovery before their first prompt.
    if (ctx.mode !== "tui") return refresh;
    // Interactive sessions start with the cached/fallback catalog. Keep the live
    // context so recovery cannot overwrite a model the user selects meanwhile.
    void refresh.catch(() => {});
  });

  // Never wait for network I/O while exiting, switching sessions, or reloading.
  pi.on("session_shutdown", cancelRefresh);
}
