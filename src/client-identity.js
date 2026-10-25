// Pinned to the statically inspected WorkBuddy AI 5.8.4 desktop artifact.
// See docs/client-identity.md. The extension version is local metadata, not wire identity.
export const EXTENSION_VERSION = "0.1.1";
export const WORKBUDDY_PROTOCOL_VERSION = "5.8.4";
export const WORKBUDDY_CLI_VERSION = "2.161.0";
export const USER_AGENT = "WorkBuddy/" + WORKBUDDY_PROTOCOL_VERSION +
  " WorkBuddy/" + WORKBUDDY_PROTOCOL_VERSION + " CLI/" + WORKBUDDY_CLI_VERSION;

// Shared by account auth, login/refresh/catalog and the final scoped chat fetch.
// Never advertise the Pi package name/version as the upstream client's identity.
export const CLIENT_HEADERS = Object.freeze({
  "User-Agent": USER_AGENT,
  "X-IDE-Type": "WorkBuddy",
  "X-IDE-Name": "WorkBuddy",
  "X-IDE-Version": WORKBUDDY_PROTOCOL_VERSION,
});
