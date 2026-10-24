import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveKey } from "../lib/credentials.ts";

delete process.env.DEEPSEEK_API_KEY;
delete process.env.EXA_API_KEY;

test("reuses Pi stored DeepSeek API key only when no override exists", async () => {
  let reads = 0;
  const stored = () => { reads++; return { type: "api_key", key: "pi-secret" }; };
  assert.equal(await resolveKey("deepseek", {}, undefined, stored), "pi-secret");
  assert.equal(await resolveKey("deepseek", { deepseekApiKey: "configured" }, undefined, stored), "configured");
  process.env.DEEPSEEK_API_KEY = "environment";
  try { assert.equal(await resolveKey("deepseek", { deepseekApiKey: "configured" }, undefined, stored), "environment"); }
  finally { delete process.env.DEEPSEEK_API_KEY; }
  assert.equal(reads, 1);
  await assert.rejects(resolveKey("deepseek", {}, undefined, () => ({ type: "oauth" })), /not configured/);
});

test("resolves environment references, including stored credentials", async () => {
  assert.equal(await resolveKey("deepseek", {}, undefined, () => ({ type: "api_key", key: "$SEARCH_TEST_KEY", env: { SEARCH_TEST_KEY: "stored-env" } })), "stored-env");
  process.env.SEARCH_TEST_KEY = "env-token";
  try { assert.equal(await resolveKey("exa", { exaApiKey: "${SEARCH_TEST_KEY}" }), "env-token"); }
  finally { delete process.env.SEARCH_TEST_KEY; }
});

test("missing environment references are rejected", async () => {
  await assert.rejects(resolveKey("exa", { exaApiKey: "$ABSENT_PI_SEARCH_TEST_KEY" }), /non-empty token/);
});

test("credential cancellation is propagated", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(resolveKey("deepseek", { deepseekApiKey: "test-token" }, controller.signal), { name: "AbortError" });
});
