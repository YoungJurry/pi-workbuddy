import { createWorkbuddyProvider, registerNativeCommands } from "./native-provider.js";
import { registerNativeLifecycle } from "./native-lifecycle.js";
import { INTL_REGION, CN_REGION } from "./regions.js";

/** Only session lifecycle hooks; no per-turn or provider-request handlers. */
export function registerWorkbuddy(pi, options) {
  const provider = createWorkbuddyProvider(options);
  pi.registerProvider(provider);
  registerNativeCommands(pi, provider);
  registerNativeLifecycle(pi, provider);
  return provider;
}

/** Both regions share one pair of session hooks, never any per-turn handlers. */
export function registerWorkbuddyProviders(pi, options) {
  const providers = [INTL_REGION, CN_REGION].map(region => createWorkbuddyProvider({ ...options, region }));
  for (const provider of providers) {
    pi.registerProvider(provider);
    registerNativeCommands(pi, provider);
  }
  registerNativeLifecycle(pi, providers);
  return providers;
}
