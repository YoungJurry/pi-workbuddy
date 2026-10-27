import { openAICompletionsApi } from "@earendil-works/pi-ai/compat";
import { registerWorkbuddyProviders } from "../src/extension.js";

// Pi supplies this API. No bundled SDK, process, server, or global transport patch.
export default function workbuddy(pi) {
  registerWorkbuddyProviders(pi, { api: openAICompletionsApi() });
}
