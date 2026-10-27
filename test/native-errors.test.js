import assert from "node:assert/strict";
import { test } from "node:test";
import { createChatFetch, normalizeSse } from "../src/native-transport.js";
import { createNativeClient, limitedText, limitedJson, ORIGIN } from "../src/native-client.js";
import { describeFailure } from "../src/native-errors.js";

// All values are synthetic, including anything resembling credentials or request IDs.
const credential = { type: "oauth", origin: ORIGIN, access: "LOCAL_ACCESS_NOT_SENT_TO_UI",
  refresh: "LOCAL_REFRESH_NOT_SENT_TO_UI", userId: "mock-user" };
const permission = JSON.stringify({ code: 11158, msg: "model is not allowed for user type [personal_free_user]",
  requestId: "synthetic-permission", displayMsg: { zh: "当前账号类型暂不支持该模型。" }, actions: ["SWITCH_MODEL"] });
const busy = JSON.stringify({ code: 14003, msg: "too many requests", requestId: "synthetic-busy",
  displayMsg: { zh: "模型繁忙，请换模型或稍后重试" },
  displayTips: { zh: "这个模型当前请求量饱和，与你的网络无关。" } });
const send = response => createChatFetch({ fetch: async () => response })(ORIGIN + "/v2/chat/completions", {
  method: "POST", headers: { Authorization: "Bearer " + credential.access }, body: "{}",
});

for (const [status, raw, code] of [
  [400, permission, 11158], [429, busy, 14003],
  [400, '{ "error": { "message": "Detailed context error", "code": "context_length_exceeded", "extra": 42 } }', "context_length_exceeded"],
  [503, "Service overloaded\nTry again later 😀", undefined],
  [502, "<html><body>Bad gateway: upstream unavailable</body></html>", undefined],
  [400, "{invalid JSON: keep this exact text", undefined],
  [403, '{"msg":"SYNTHETIC_ECHOED_TOKEN"}', undefined],
  [500, "Long diagnostic: " + "详情😀".repeat(10000) + " END", undefined],
]) {
  test(`HTTP ${status}: complete upstream body survives (${String(code ?? raw.slice(0, 25))})`, async () => {
    const response = await send(new Response(raw, { status,
      headers: { "Content-Type": "application/json", "Retry-After": "12", "Content-Length": "999", "Content-Encoding": "gzip" } }));
    assert.equal(response.status, status);
    assert.equal(response.headers.get("retry-after"), "12");
    assert.equal(response.headers.get("content-length"), null);
    assert.equal(response.headers.get("content-encoding"), null);
    const body = await response.json();
    assert.equal(body.error.message, raw); // No field filtering, reserialization, or truncation.
    assert.equal(body.error.code, code);
    assert.ok(!body.error.message.includes(credential.access));
    assert.ok(!body.error.message.includes(credential.refresh));
  });
}

test("HTTP 200 JSON business errors become stream errors without losing text or status", async () => {
  const response = await send(new Response(busy, { headers: { "Content-Type": "application/json" } }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/event-stream");
  const frame = JSON.parse((await response.text()).slice(6).trim());
  assert.equal(frame.error.message, busy);
  assert.equal(frame.error.code, 14003);
});

test("empty HTTP error has a useful status fallback", async () => {
  const response = await send(new Response(null, { status: 503, statusText: "Service Unavailable" }));
  assert.equal((await response.json()).error.message, "WorkBuddy HTTP 503: Service Unavailable");
});

for (const raw of [busy, permission, '{"error":{"code":"quota_exceeded","message":"Quota exhausted 😀","extra":"keep me"}}']) {
  test("SSE error data survives UTF-8 fragmentation: " + raw.slice(0, 24), async () => {
    const bytes = new TextEncoder().encode("data: " + raw + "\r\n\r\n");
    const source = new ReadableStream({ start(controller) {
      for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
      controller.close();
    } });
    await assert.rejects(new Response(normalizeSse(source)).text(), error => error.message === raw);
  });
}

test("SSE error after partial content is not mistaken for successful completion", async () => {
  const source = new Response('data: {"choices":[{"delta":{"content":"hello"}}]}\n\n' +
    "data: " + busy + "\n\n").body;
  const reader = normalizeSse(source).getReader();
  assert.match(new TextDecoder().decode((await reader.read()).value), /hello/);
  await assert.rejects(reader.read(), error => error.message === busy);
  reader.releaseLock();
});

for (const [status, raw] of [[403, permission], [200, busy], [502, "upstream unavailable"], [200, "{broken JSON"]]) {
  test(`catalog errors retain original text in diagnostics (HTTP ${status})`, async () => {
    const client = createNativeClient({ fetch: async () => new Response(raw, { status }) });
    await assert.rejects(client.catalog(credential), error => {
      assert.ok(error.message.includes(raw));
      assert.ok(describeFailure(new Error("host wrapper", { cause: error })).includes(raw));
      assert.ok(!describeFailure(error).includes(credential.access));
      return true;
    });
  });
}

test("login and refresh errors retain official response bodies", async () => {
  const client = createNativeClient({ fetch: async () => new Response(permission, { status: 403 }) });
  for (const operation of [() => client.login({ notify() {} }), () => client.refresh(credential)]) {
    await assert.rejects(operation(), error => error.message.includes(permission));
  }
});

test("response resource limits and cancellation remain enforced", async () => {
  let cancelled = false;
  const body = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(33)); }, cancel() { cancelled = true; } });
  await assert.rejects(limitedText(new Response(body), 32), error => error.diagnosticCode === "response-size");
  assert.equal(cancelled, true);
  assert.equal(await limitedText(new Response(null)), "");
  await assert.rejects(limitedJson(new Response(null)), error => error.diagnosticCode === "empty-response");
  assert.deepEqual(await limitedJson(new Response('{"ok":true}')), { ok: true });
  const broken = new ReadableStream({ start(c) { c.error(new Error("read failure")); } });
  await assert.rejects(limitedText(new Response(broken)), error => error.diagnosticCode === "response-read");
});
