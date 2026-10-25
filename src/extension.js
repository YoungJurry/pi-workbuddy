import { createWorkbuddyProvider, registerNativeCommands } from "./native-provider.js";
import { registerNativeLifecycle } from "./native-lifecycle.js";

/** Only session lifecycle hooks; no per-turn or provider-request handlers. */
export function registerWorkbuddy(pi, options) {
  const provider = createWorkbuddyProvider(options);
  pi.registerProvider(provider);
  registerNativeCommands(pi, provider);
  registerNativeLifecycle(pi, provider);
  return provider;
}
