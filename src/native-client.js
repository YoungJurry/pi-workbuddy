import { setTimeout as sleep } from "node:timers/promises";
import { WorkbuddyError } from "./native-errors.js";
import { CLIENT_HEADERS } from "./client-identity.js";

export const ORIGIN = "https://www.workbuddy.ai";
export const BASE_URL = ORIGIN + "/v2";
const BROWSER_ORIGINS = new Set([ORIGIN, "https://workbuddy.ai", "https://www.codebuddy.ai"]);
const ACCOUNT_DOMAINS = new Set(["www.workbuddy.ai", "workbuddy.ai", "www.codebuddy.ai"]);
const LIMIT = 2 * 1024 * 1024;

export function safeHeader(value, name = "account metadata") {
  if (typeof value !== "string" || !value || value.length > (name.includes("token") ? 16384 : 2048) || /[\r\n\0]/.test(value)) {
    throw new WorkbuddyError("metadata", "Invalid WorkBuddy " + name + ".");
  }
  return value;
}

export function accountHeaders(credential) {
  if (credential?.type !== "oauth" || credential.origin !== ORIGIN) {
    throw new WorkbuddyError("credentials", "WorkBuddy credentials are missing or belong to a different endpoint. Run /login.");
  }
  validDomain({ domain: credential.domain });
  const headers = {
    ...CLIENT_HEADERS,
    Authorization: "Bearer " + safeHeader(credential.access, "access token"),
    "X-User-Id": safeHeader(credential.userId, "user ID"),
    "X-Domain": credential.domain || "www.workbuddy.ai",
    "X-Product": "SaaS", "X-Requested-With": "XMLHttpRequest",
  };
  if (credential.enterpriseId) {
    headers["X-Enterprise-Id"] = safeHeader(credential.enterpriseId);
    headers["X-Tenant-Id"] = headers["X-Enterprise-Id"];
  }
  return headers;
}

// Keep a resource limit, not a redaction limit. Errors retain the original UTF-8 text.
export async function limitedText(response, limit = LIMIT) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new WorkbuddyError("response-size", "WorkBuddy response exceeds the size limit.");
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof WorkbuddyError) throw error;
    throw new WorkbuddyError("response-read", "WorkBuddy response could not be read.");
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function limitedJson(response, limit = LIMIT) {
  const text = await limitedText(response, limit);
  if (!text) throw new WorkbuddyError("empty-response", "WorkBuddy returned an empty response.");
  try { return JSON.parse(text); }
  catch { throw new WorkbuddyError("invalid-json", "WorkBuddy returned invalid JSON."); }
}

function validDomain(token) {
  if (token.domain && !ACCOUNT_DOMAINS.has(token.domain)) {
    throw new WorkbuddyError("account-domain", "WorkBuddy returned an unsupported account domain.");
  }
}

function tokenCredential(token, account, previous, now) {
  if (!token || typeof token !== "object") throw new Error("WorkBuddy returned no token.");
  validDomain(token);
  const access = safeHeader(token.accessToken, "access token");
  const refresh = token.refreshToken === undefined ? previous?.refresh || "" : token.refreshToken;
  if (refresh !== "") safeHeader(refresh, "refresh token");
  const expires = Number.isFinite(token.expiresAt) ? token.expiresAt :
    Number.isFinite(token.expiresIn) ? now + token.expiresIn * 1000 : undefined;
  if (!Number.isSafeInteger(expires) || expires <= now) {
    throw new Error("WorkBuddy returned missing or expired token expiry. Please sign in again.");
  }
  return {
    type: "oauth", origin: ORIGIN, access, refresh, expires,
    domain: token.domain || previous?.domain || "www.workbuddy.ai",
    userId: safeHeader(String(account?.uid ?? previous?.userId ?? ""), "user ID"),
    ...(account?.enterpriseId || previous?.enterpriseId ?
      { enterpriseId: safeHeader(String(account?.enterpriseId ?? previous.enterpriseId)) } : {}),
  };
}

export function createNativeClient({
  fetch: fetchImpl = globalThis.fetch, requestTimeoutMs = 15000,
  loginTimeoutMs = 300000, pollIntervalMs = 1000, now = Date.now,
} = {}) {
  async function request(path, { method = "GET", credential, signal, pendingCode, headers = {}, body = {} } = {}) {
    const url = new URL(path, ORIGIN);
    if (url.origin !== ORIGIN || url.username || url.password) throw new WorkbuddyError("endpoint", "Untrusted WorkBuddy endpoint.");
    const timed = AbortSignal.timeout(requestTimeoutMs);
    const activeSignal = signal ? AbortSignal.any([signal, timed]) : timed;
    // Validate credential metadata before fetch so validation failures are not mislabeled as network errors.
    const requestHeaders = {
      "Content-Type": "application/json", "X-Domain": "www.workbuddy.ai",
      "X-Product": "SaaS", "X-Requested-With": "XMLHttpRequest",
      ...CLIENT_HEADERS,
      ...(credential ? accountHeaders(credential) : {}), ...headers,
    };
    let response;
    try {
      response = await fetchImpl(url, {
        method, redirect: "error", signal: activeSignal, headers: requestHeaders,
        ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
      });
    } catch {
      if (signal?.aborted) throw new WorkbuddyError("cancelled", "WorkBuddy operation cancelled or timed out.");
      if (timed.aborted) throw new WorkbuddyError("request-timeout", "WorkBuddy request timed out.");
      throw new WorkbuddyError("network", "Cannot reach WorkBuddy. Check your connection or retry.");
    }
    const text = await limitedText(response);
    let envelope;
    try { envelope = JSON.parse(text); } catch {
      if (response.ok) throw new WorkbuddyError(text ? "invalid-json" : "empty-response",
        text || "WorkBuddy returned an empty response.");
    }
    if (response.ok && pendingCode !== undefined && envelope?.code === pendingCode) return undefined;
    if (!response.ok || envelope?.error || (envelope?.code !== undefined && envelope.code !== 0)) {
      throw new WorkbuddyError("http", "WorkBuddy HTTP " + response.status + ": " +
        (text || response.statusText || "Empty response body"), {
        status: response.status, businessCode: envelope?.error?.code ?? envelope?.code,
      });
    }
    if (!envelope || typeof envelope !== "object" || envelope.data === undefined) {
      throw new WorkbuddyError("envelope", "WorkBuddy returned an unexpected response envelope.");
    }
    return envelope.data;
  }

  return {
    async login(interaction) {
      const deadline = AbortSignal.timeout(loginTimeoutMs);
      const signal = interaction.signal ? AbortSignal.any([interaction.signal, deadline]) : deadline;
      interaction.notify({ type: "progress", message: "Requesting WorkBuddy browser login…" });
      const state = await request("/v2/plugin/auth/state?platform=workbuddy-ai", { method: "POST", signal });
      if (typeof state?.state !== "string" || !state.state || state.state.length > 4096) {
        throw new Error("WorkBuddy returned an invalid login state.");
      }
      let authUrl;
      try { authUrl = new URL(state.authUrl); } catch { throw new Error("Invalid WorkBuddy login URL."); }
      if (!BROWSER_ORIGINS.has(authUrl.origin) || authUrl.username || authUrl.password) {
        throw new Error("WorkBuddy returned an untrusted login URL.");
      }
      interaction.notify({ type: "auth_url", url: authUrl.href, instructions: "Sign in with your WorkBuddy account in the browser. Pi will wait; Escape cancels." });
      const query = encodeURIComponent(state.state);
      let token;
      while (!token) {
        signal.throwIfAborted();
        token = await request("/v2/plugin/auth/token?state=" + query, { signal, pendingCode: 11217 });
        if (!token) await sleep(pollIntervalMs, undefined, { signal });
      }
      // Fetch account before creating/storing any Pi credential.
      safeHeader(token.accessToken, "access token");
      validDomain(token);
      let account;
      while (!account) {
        signal.throwIfAborted();
        account = await request("/v2/plugin/login/account?state=" + query, {
          signal, pendingCode: 12151, headers: { Authorization: "Bearer " + token.accessToken },
        });
        if (!account) await sleep(pollIntervalMs, undefined, { signal });
      }
      const credential = tokenCredential(token, account, undefined, now());
      interaction.notify({ type: "info", message: "WorkBuddy login completed. Run /workbuddy refresh, then select a model with /model." });
      return credential;
    },
    async refresh(credential, signal) {
      accountHeaders(credential); // Validate binding before any I/O.
      if (!credential.refresh) throw new Error("WorkBuddy did not issue a refresh token. Run /login again.");
      const token = await request("/v2/plugin/auth/token/refresh", {
        method: "POST", credential, signal,
        headers: { "X-Refresh-Token": safeHeader(credential.refresh), "X-Auth-Refresh-Source": "plugin" },
      });
      return tokenCredential(token, undefined, credential, now());
    },
    async catalog(credential, signal) {
      return request("/v3/config", { credential, signal });
    },
  };
}
