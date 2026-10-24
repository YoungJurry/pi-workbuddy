import { randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";
import { ORIGIN, limitedJson } from "./native-client.js";
import { USER_AGENT, EXTENSION_VERSION } from "./client-identity.js";

// Normalize complete SSE frames, never individual TCP/UTF-8 chunks.
export function normalizeSse(body) {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let pending = "";
  const ids = new Set();
  const indexes = new Map();
  let nextIndex = 0;
  function frame(text) {
    const lines = text.split(/\r?\n/);
    const data = lines.filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
    if (!data || data.trim() === "[DONE]") return encoder.encode(text + "\n\n");
    let value;
    try { value = JSON.parse(data); } catch { throw new Error("WorkBuddy returned malformed SSE JSON."); }
    if (value.error || (typeof value.code === "number" && value.code !== 0)) {
      throw new Error("WorkBuddy reported a stream error.");
    }
    for (const choice of value.choices ?? []) {
      for (const call of choice.delta?.tool_calls ?? []) {
        if (!Number.isInteger(call.index)) {
          if (call.id && indexes.has(call.id)) call.index = indexes.get(call.id);
          else if (!call.id && nextIndex > 0) call.index = nextIndex - 1;
          else { call.index = nextIndex++; if (call.id) indexes.set(call.id, call.index); }
        } else {
          nextIndex = Math.max(nextIndex, call.index + 1);
          if (call.id) indexes.set(call.id, call.index);
        }
        if (call.id) {
          if (ids.has(call.id)) delete call.id;
          else ids.add(call.id);
        }
      }
    }
    return encoder.encode("data: " + JSON.stringify(value) + "\n\n");
  }
  function drain(controller, final = false) {
    let match;
    while ((match = /\r?\n\r?\n/.exec(pending))) {
      const value = pending.slice(0, match.index);
      if (value.length > 1024 * 1024) throw new Error("WorkBuddy SSE frame is too large.");
      pending = pending.slice(match.index + match[0].length);
      controller.enqueue(frame(value));
    }
    if (pending.length > 1024 * 1024) throw new Error("WorkBuddy SSE frame is too large.");
    if (final && pending.trim()) { controller.enqueue(frame(pending)); pending = ""; }
  }
  return body.pipeThrough(new TransformStream({
    transform(bytes, controller) { pending += decoder.decode(bytes, { stream: true }); drain(controller); },
    flush(controller) { pending += decoder.decode(); drain(controller, true); },
  }));
}

export function createChatFetch({ fetch: fetchImpl = globalThis.fetch, gzip = true, sessionId } = {}) {
  const conversationId = sessionId || randomUUID();
  return async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin !== ORIGIN || url.pathname !== "/v2/chat/completions" || url.search ||
      url.username || url.password || request.method !== "POST") {
      throw new Error("Refusing to send WorkBuddy credentials to an untrusted endpoint.");
    }
    const headers = new Headers(request.headers);
    const requestId = randomUUID();
    for (const [key, value] of Object.entries({
      "X-Conversation-ID": conversationId, "X-Conversation-Request-ID": requestId,
      "X-Conversation-Message-ID": requestId, "X-Request-ID": requestId,
      "X-Agent-Intent": "craft", "X-IDE-Type": "pi", "X-IDE-Name": "pi-workbuddy",
      "X-IDE-Version": EXTENSION_VERSION, "X-Product": "SaaS", "X-Requested-With": "XMLHttpRequest",
      "User-Agent": USER_AGENT,
      // Conservative privacy default: do not opt prompts into model optimization.
      "X-Private-Data": "true", "Content-Type": "application/json", Accept: "text/event-stream",
    })) headers.set(key, value);
    const body = Buffer.from(await request.arrayBuffer());
    if (gzip) headers.set("Content-Encoding", "gzip");
    else headers.delete("Content-Encoding");
    headers.delete("Content-Length");
    let response;
    try {
      response = await fetchImpl(url, {
        method: "POST", headers, body: gzip ? gzipSync(body) : body,
        redirect: "error", signal: request.signal,
      });
    } catch {
      throw new Error(request.signal.aborted ? "WorkBuddy request cancelled." : "WorkBuddy connection failed.");
    }
    if (!response.ok) {
      let code;
      try { const value = await limitedJson(response); code = value?.error?.code ?? value?.code; } catch {}
      // Keep status, safe business code, and retry metadata; never expose upstream bodies/tokens.
      const contextOverflow = code === "context_length_exceeded";
      const message = contextOverflow ? "context_length_exceeded" : "WorkBuddy request failed (HTTP " + response.status +
        (typeof code === "number" ? "; code " + code : "") + ").";
      const outHeaders = new Headers({ "Content-Type": "application/json" });
      const retry = response.headers.get("retry-after");
      if (retry) outHeaders.set("Retry-After", retry);
      return new Response(JSON.stringify({ error: { message, ...(contextOverflow ? { code } : {}) } }), {
        status: response.status, headers: outHeaders,
      });
    }
    if (!response.headers.get("content-type")?.includes("text/event-stream") || !response.body) {
      await response.body?.cancel();
      throw new Error("WorkBuddy did not return an SSE stream.");
    }
    const responseHeaders = new Headers(response.headers);
    // The fetch implementation has already decoded transport compression.
    responseHeaders.delete("content-encoding");
    responseHeaders.delete("content-length");
    return new Response(normalizeSse(response.body), { status: response.status, headers: responseHeaders });
  };
}
