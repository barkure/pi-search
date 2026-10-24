import { test } from "node:test";
import assert from "node:assert/strict";
import { search, formatResults, mergeResults } from "../lib/search.ts";

const config = { exaApiKey: "exa-test-secret", deepseekApiKey: "deepseek-test-secret" };
const result = { title: "Docs", url: "https://example.com/docs", summary: "Source excerpt", date: "2026-10-01" };
const ok = () => Response.json({ results: [result] });

test("auto switches once on quota errors and preserves the reason", async () => {
  const calls: string[] = [];
  const output = await search({ query: "docs" }, config, undefined, async (url, init) => {
    calls.push(String(url));
    if (calls.length <= 2) return new Response("quota", { status: 429, headers: { "Retry-After": "0" } });
    assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer deepseek-test-secret");
    assert.deepEqual(JSON.parse(String(init?.body)), { query: "docs", count: 5, need_content: false });
    return ok();
  });
  assert.equal(calls.length, 3);
  assert.equal(output.sources[0].provider, "deepseek");
  assert.match(formatResults("docs", output), /exa: HTTP 429/);
  assert.equal(output.sources[0].results[0].snippet, "Source excerpt");
});

test("explicit provider and authentication failures never switch or expose error bodies", async () => {
  for (const [provider, status] of [["exa", 429], ["auto", 401]] as const) {
    let calls = 0;
    await assert.rejects(search({ query: "docs" }, { ...config, providers: provider === "auto" ? undefined : [provider] }, undefined, async () => {
      calls++;
      return new Response(config.exaApiKey, { status, headers: { "Retry-After": "0" } });
    }), error => error instanceof Error && error.message === `exa: HTTP ${status}`);
    assert.equal(calls, status === 429 ? 2 : 1);
  }
});

test("cancellation stops the route instead of trying backup", async () => {
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(search({ query: "docs" }, config, controller.signal, async () => {
    calls++;
    controller.abort();
    throw new Error("aborted");
  }), { name: "AbortError" });
  assert.equal(calls, 1);
});

test("domain/date filters map to each provider's protocol", async () => {
  for (const provider of ["exa", "deepseek"] as const) {
    await search({ query: "docs", domainFilter: ["example.com", "-spam.com"], recencyFilter: "week" }, { ...config, providers: [provider] }, undefined, async (_url, init) => {
      const body = JSON.parse(String(init?.body));
      if (provider === "exa") {
        assert.deepEqual(body.includeDomains, ["example.com"]);
        assert.deepEqual(body.excludeDomains, ["spam.com"]);
        assert.ok(Date.parse(body.startPublishedDate));
      } else {
        assert.match(body.query, /^docs site:example.com -site:spam.com after:\d{4}-\d{2}-\d{2}$/);
      }
      return ok();
    });
  }
});

test("DeepSeek checks Unicode length including appended filters before sending", async () => {
  let calls = 0;
  const transport = async () => { calls++; return ok(); };
  await search({ query: "字".repeat(128) }, { ...config, providers: ["deepseek"] }, undefined, transport);
  await assert.rejects(search({ query: "字".repeat(128), domainFilter: ["example.com"] }, { ...config, providers: ["deepseek"] }, undefined, transport), /128 characters/);
  assert.equal(calls, 1);
});

test("empty results try the next provider, malformed results switch, URLs are deduplicated", async () => {
  let calls = 0;
  const empty = await search({ query: "docs" }, config, undefined, async () => { calls++; return Response.json({ results: [] }); });
  assert.equal(calls, 2);
  assert.deepEqual(empty.sources[0].results, []);
  assert.deepEqual(empty.attempts, ["exa: No results.", "deepseek: No results."]);
  calls = 0;
  const second = await search({ query: "docs" }, config, undefined, async () => { calls++; return calls === 1 ? Response.json({ results: [] }) : ok(); });
  assert.equal(second.sources[0].provider, "deepseek");
  assert.equal(second.sources[0].results.length, 1);
  calls = 0;
  const output = await search({ query: "docs" }, config, undefined, async () => {
    calls++;
    return calls === 1 ? Response.json({ broken: true }) : Response.json({ results: [result, result, { url: "javascript:alert(1)" }] });
  });
  assert.equal(calls, 2);
  assert.equal(output.sources[0].results.length, 1);
});

test("missing primary key is skipped and explicit missing key fails", async () => {
  const output = await search({ query: "docs" }, { deepseekApiKey: "test" }, undefined, async () => ok());
  assert.equal(output.sources[0].provider, "deepseek");
  assert.match(output.attempts[0], /not configured/);
  await assert.rejects(search({ query: "docs" }, { providers: ["exa"] }, undefined, async () => { throw new Error("must not call"); }), /not configured/);
});


test("parallel starts both requests before either completes, preserving selected order", async () => {
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const calls: string[] = [];
  const output = await search({ query: "docs" }, { ...config, providers: ["deepseek", "exa"], mode: "parallel" }, undefined, async url => {
    calls.push(String(url));
    if (calls.length === 2) release();
    await barrier;
    return ok();
  });
  assert.equal(calls.length, 2);
  assert.deepEqual(output.sources.map(s => s.provider), ["deepseek", "exa"]);
  assert.match(formatResults("docs", output), /Sources: deepseek/);
  assert.match(formatResults("docs", output), /Sources: deepseek, exa/);
});

test("parallel preserves successful results even when another provider fails authentication", async () => {
  const output = await search({ query: "docs" }, { ...config, mode: "parallel" }, undefined, async url =>
    String(url).includes("exa.ai") ? new Response("secret", { status: 401 }) : ok());
  assert.equal(output.sources[0].provider, "deepseek");
  assert.deepEqual(output.attempts, ["exa: HTTP 401"]);
  await assert.rejects(search({ query: "docs" }, { ...config, mode: "parallel" }, undefined, async () => new Response("secret", { status: 503, headers: { "Retry-After": "0" } })), /exa: HTTP 503\ndeepseek: HTTP 503/);
});

test("tool arguments cannot override configured routing", async () => {
  const calls: string[] = [];
  const output = await search({ query: "docs", providers: ["exa"], mode: "parallel" } as any,
    { ...config, providers: ["deepseek"], mode: "fallback" }, undefined, async url => {
      calls.push(String(url)); return ok();
    });
  assert.equal(calls.length, 1);
  assert.match(calls[0], /deepseek/);
  assert.equal(output.mode, "fallback");
  const configured = await search({ query: "docs" }, { ...config, providers: ["deepseek", "exa"], mode: "parallel" }, undefined, async () => ok());
  assert.deepEqual(configured.sources.map(s => s.provider), ["deepseek", "exa"]);
});

test("parallel cancellation aborts every outstanding request", async () => {
  const controller = new AbortController();
  let started = 0, aborted = 0;
  await assert.rejects(search({ query: "docs" }, { ...config, mode: "parallel" }, controller.signal, async (_url, init) => {
    started++;
    return new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => { aborted++; reject(new Error("cancelled")); }, { once: true });
      if (started === 2) controller.abort();
    });
  }), { name: "AbortError" });
  assert.equal(started, 2);
  assert.equal(aborted, 2);
});

test("invalid selection or mode fails before any request", async () => {
  for (const options of [
    { providers: [] }, { providers: ["exa", "exa"] }, { providers: ["unknown"] }, { mode: "unknown" },
  ]) {
    await assert.rejects(search({ query: "docs" }, { ...config, ...options } as any, undefined, async () => {
      assert.fail("must not send invalid selection");
    }), /providers|mode/);
  }
});

test("merges shared URLs and identical excerpts while retaining distinct evidence", () => {
  const output = { mode: "parallel" as const, attempts: [], sources: [
    { provider: "exa" as const, results: [result] },
    { provider: "deepseek" as const, results: [
      { ...result, snippet: "Different evidence" },
      { ...result, snippet: "Source excerpt" },
      { ...result, url: result.url + "?version=2", snippet: "Other version" },
    ] },
  ] };
  output.sources[0].results = [{ ...result, snippet: "Source excerpt" }];
  const merged = mergeResults(output as any);
  assert.equal(merged.length, 2);
  assert.deepEqual(merged[0].providers, ["exa", "deepseek"]);
  assert.equal(merged[0].excerpts.length, 2);
  assert.deepEqual(merged[0].excerpts[0].providers, ["exa", "deepseek"]);
  const formatted = formatResults("docs", output as any);
  assert.equal(formatted.split("Source excerpt").length - 1, 1);
  assert.match(formatted, /Different evidence/);
});

test("refresh bypasses the cache read but stores the new results", async () => {
  const { SearchCache } = await import("../lib/cache.ts");
  const cache = new SearchCache();
  let version = 0;
  const transport = async () => { version++; return Response.json({ results: [{ ...result, summary: `v${version}` }] }); };
  const one = { ...config, providers: ["exa" as const] };
  await search({ query: "docs" }, one, undefined, transport, undefined, cache);
  const refreshed = await search({ query: "docs" }, one, undefined, transport, undefined, cache, true);
  assert.equal(refreshed.sources[0].results[0].snippet, "v2");
  const later = await search({ query: "docs" }, one, undefined, transport, undefined, cache);
  assert.equal(later.sources[0].cached, true);
  assert.equal(later.sources[0].results[0].snippet, "v2");
});
