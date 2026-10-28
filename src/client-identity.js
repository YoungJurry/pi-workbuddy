// Pinned to the statically inspected WorkBuddy AI 5.8.4 desktop artifact.
// See docs/client-identity.md. The extension version is local metadata, not wire identity.
export const EXTENSION_VERSION = "0.2.2";
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

// Independently pinned to the official CN 5.8.3 desktop artifact.
// See docs/cn-protocol.md; do not inherit the international app version.
export const CN_WORKBUDDY_PROTOCOL_VERSION = "5.8.3";
export const CN_WORKBUDDY_CLI_VERSION = "2.161.0";
export const CN_USER_AGENT = "WorkBuddy/" + CN_WORKBUDDY_PROTOCOL_VERSION +
  " WorkBuddy/" + CN_WORKBUDDY_PROTOCOL_VERSION + " CLI/" + CN_WORKBUDDY_CLI_VERSION;
export const CN_CLIENT_HEADERS = Object.freeze({
  "User-Agent": CN_USER_AGENT,
  "X-IDE-Type": "WorkBuddy",
  "X-IDE-Name": "WorkBuddy",
  "X-IDE-Version": CN_WORKBUDDY_PROTOCOL_VERSION,
});
