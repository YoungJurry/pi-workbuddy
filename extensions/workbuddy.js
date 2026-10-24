import { openAICompletionsApi } from "@earendil-works/pi-ai/compat";
import { registerWorkbuddy } from "../src/extension.js";

// Pi supplies this API. No bundled SDK, process, server, or global transport patch.
export default function workbuddy(pi) {
  registerWorkbuddy(pi, { api: openAICompletionsApi() });
}
