import { CLIENT_HEADERS, CN_CLIENT_HEADERS } from "./client-identity.js";

// Fixed regional profiles, never inferred from a model URL or credential metadata.
// Each provider owns its own origin, OAuth entry, catalog and scoped chat fetch.
export const INTL_REGION = Object.freeze({
  id: "workbuddy",
  name: "WorkBuddy AI",
  origin: "https://www.workbuddy.ai",
  baseUrl: "https://www.workbuddy.ai/v2",
  domain: "www.workbuddy.ai",
  platform: "workbuddy-ai",
  loginAccountPath: "/v2/plugin/login/account",
  loginAccountUsesState: true,
  browserOrigins: Object.freeze(["https://www.workbuddy.ai", "https://workbuddy.ai", "https://www.codebuddy.ai"]),
  accountDomains: Object.freeze(["www.workbuddy.ai", "workbuddy.ai", "www.codebuddy.ai"]),
  clientHeaders: CLIENT_HEADERS,
  fallbackName: "WorkBuddy Default (fallback)",
  excludeSg: true,
});

// Official CN product.json internalDomain production entries only. No staging,
// international, wildcard SSO, self-hosted endpoint, or cross-origin failover.
// Account X-Domain prefers the server-issued token.domain; this is its fallback.
// Protocol provenance and supported scope: docs/cn-protocol.md.
export const CN_REGION = Object.freeze({
  id: "workbuddy-cn",
  name: "WorkBuddy AI CN",
  origin: "https://www.workbuddy.cn",
  baseUrl: "https://www.workbuddy.cn/v2",
  domain: "www.workbuddy.cn",
  platform: "workbuddy",
  // CN selects account-scoped-external-link, not the legacy external-link flow.
  loginAccountPath: "/v2/plugin/account",
  loginAccountUsesState: false,
  browserOrigins: Object.freeze(["https://www.workbuddy.cn", "https://www.codebuddy.cn", "https://copilot.tencent.com"]),
  accountDomains: Object.freeze(["www.workbuddy.cn", "www.codebuddy.cn", "copilot.tencent.com"]),
  clientHeaders: CN_CLIENT_HEADERS,
  fallbackName: "WorkBuddy Default (fallback) CN",
  // The -sg exclusion is an international integration policy, not a wire rule.
  excludeSg: false,
});
