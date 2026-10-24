import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchWithRetry, retryDelay } from "../lib/http.ts";

const url = "https://example.com/search";
test("Retry-After accepts seconds and HTTP dates, invalid values use short backoff", () => {
  assert.equal(retryDelay("2"), 2000);
  const now = Date.parse("2026-10-24T00:00:00Z");
  assert.equal(retryDelay("Sat, 24 Oct 2026 00:00:03 GMT", now), 3000);
  assert.equal(retryDelay("Fri, 23 Oct 2026 00:00:00 GMT", now), 0);
  assert.equal(retryDelay("invalid"), 500);
});

test("429 and 5xx retry once, sharing the exact signal", async () => {
  for (const status of [429, 503]) {
    let calls = 0;
    const signal = AbortSignal.timeout(1000);
    const response = await fetchWithRetry(url, { signal }, Date.now() + 1000, async (_url, init) => {
      assert.equal(init?.signal, signal);
      calls++;
      return new Response(null, { status: calls === 1 ? status : 200, headers: { "Retry-After": "0" } });
    });
    assert.equal(response.status, 200);
    assert.equal(calls, 2);
  }
});

test("repeated failures stop after two requests; auth errors never retry", async () => {
  for (const status of [429, 503, 401]) {
    let calls = 0;
    const response = await fetchWithRetry(url, {}, Date.now() + 1000, async () => {
      calls++;
      return new Response(null, { status, headers: { "Retry-After": "0" } });
    });
    assert.equal(response.status, status);
    assert.equal(calls, status === 401 ? 1 : 2);
  }
});

test("long Retry-After falls back without exceeding the deadline or retrying early", async () => {
  let calls = 0;
  await assert.rejects(fetchWithRetry(url, {}, Date.now() + 1000, async () => {
    calls++;
    return new Response(null, { status: 429, headers: { "Retry-After": "60" } });
  }), /remaining request budget/);
  assert.equal(calls, 1);
});

test("cancellation and provider deadline interrupt backoff", async () => {
  for (const timeout of [false, true]) {
    const controller = new AbortController();
    const signal = timeout ? AbortSignal.timeout(20) : controller.signal;
    let calls = 0;
    await assert.rejects(fetchWithRetry(url, { signal }, Date.now() + 1000, async () => {
      calls++;
      if (!timeout) setTimeout(() => controller.abort(), 10);
      return new Response(null, { status: 503, headers: { "Retry-After": "0.5" } });
    }), { name: "AbortError" });
    assert.equal(calls, 1);
  }
});

test("transport ECONNRESET and ETIMEDOUT retry, including wrapped fetch causes", async () => {
  for (const code of ["ECONNRESET", "ETIMEDOUT"]) {
    let calls = 0;
    const signal = AbortSignal.timeout(2000);
    const response = await fetchWithRetry(url, { signal }, Date.now() + 2000, async (_url, init) => {
      assert.equal(init?.signal, signal);
      calls++;
      if (calls === 1) throw new TypeError("fetch failed", { cause: Object.assign(new Error("socket"), { code }) });
      return new Response(null);
    });
    assert.equal(response.status, 200);
    assert.equal(calls, 2);
  }
});

test("non-transient transport errors do not retry", async () => {
  for (const code of ["CERT_HAS_EXPIRED", "ERR_INVALID_URL", "ENOTFOUND"]) {
    let calls = 0;
    await assert.rejects(fetchWithRetry(url, {}, Date.now() + 2000, async () => {
      calls++;
      throw Object.assign(new Error("failure"), { code });
    }));
    assert.equal(calls, 1);
  }
});

test("network retry does not outlive deadline or ignore cancellation", async () => {
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(fetchWithRetry(url, { signal: controller.signal }, Date.now() + 2000, async () => {
    calls++;
    setTimeout(() => controller.abort(), 10);
    throw Object.assign(new Error("reset"), { code: "ECONNRESET" });
  }), { name: "AbortError" });
  assert.equal(calls, 1);
  calls = 0;
  await assert.rejects(fetchWithRetry(url, {}, Date.now() + 100, async () => {
    calls++;
    throw Object.assign(new Error("timeout"), { code: "ETIMEDOUT" });
  }), /remaining request budget/);
  assert.equal(calls, 1);
});
