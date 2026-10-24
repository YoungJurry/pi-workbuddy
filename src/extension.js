import { createWorkbuddyProvider, registerNativeCommands } from "./native-provider.js";
import { registerNativeLifecycle } from "./native-lifecycle.js";

/** The only global event this package registers is session_start. */
export function registerWorkbuddy(pi, options) {
  const provider = createWorkbuddyProvider(options);
  pi.registerProvider(provider);
  registerNativeCommands(pi, provider);
  registerNativeLifecycle(pi, provider);
  return provider;
}
