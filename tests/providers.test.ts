import { test } from "node:test";
import assert from "node:assert/strict";
import { providers, normalizeDomain, matchesDomains } from "../lib/providers.ts";
import { search, mergeResults, type SearchOutput } from "../lib/search.ts";

const config = { exaApiKey: "test-exa", deepseekApiKey: "test-deepseek", providers: ["deepseek", "exa"] as ("deepseek" | "exa")[] };

test("Exa search requests highlights only; title/link survive missing excerpts", () => {
  assert.deepEqual(providers.exa.body({ query: "docs" }).contents, { highlights: true });
  const result = providers.exa.parse({ results: [{ url: "https://example.com", title: "Docs" }] }, 5);
  assert.equal(result.length, 1);
  assert.equal(result[0].snippet, "");
});

test("IDN and wildcard filters normalize without accepting URLs or paths", () => {
  assert.equal(normalizeDomain("*.例子.中国"), "*.xn--fsqu00a.xn--fiqs8s");
  assert.equal(normalizeDomain("EXAMPLE.COM."), "example.com");
  for (const bad of ["https://example.com", "example.com/path", "foo@bar.com", "foo.*.com"]) assert.throws(() => normalizeDomain(bad));
  assert.equal(matchesDomains("https://www.example.com/docs", ["*.example.com"]), true);
  assert.equal(matchesDomains("https://example.com", ["*.example.com"]), false);
  assert.equal(matchesDomains("https://notexample.com", ["example.com"]), false);
  assert.equal(matchesDomains("https://example.com", ["-*.example.com"]), true);
  assert.equal(matchesDomains("https://www.example.com", ["-*.example.com"]), false);
  assert.equal(matchesDomains("https://例子.中国/docs", ["例子.中国"]), true);
});

test("unsupported DeepSeek query falls back without dropping filters", async () => {
  let calls = 0;
  const output = await search({ query: "x".repeat(128), domainFilter: ["example.com"], recencyFilter: "week" }, config, undefined, async (url, init) => {
    calls++;
    assert.match(String(url), /exa/);
    const body = JSON.parse(String(init?.body));
    assert.deepEqual(body.includeDomains, ["example.com"]);
    assert.ok(body.startPublishedDate);
    return Response.json({ results: [{ url: "https://example.com/docs", title: "Docs" }] });
  });
  assert.equal(calls, 1);
  assert.equal(output.sources[0].provider, "exa");
  assert.match(output.attempts[0], /128 characters/);
});

test("wildcard constraints are enforced after provider retrieval", async () => {
  const output = await search({ query: "docs", domainFilter: ["*.example.com"] }, { ...config, providers: ["exa"] }, undefined, async () => Response.json({ results: [
    { url: "https://example.com" }, { url: "https://a.example.com" }, { url: "https://other.com" },
  ] }));
  assert.deepEqual(output.sources[0].results.map(r => r.url), ["https://a.example.com/"]);
});

test("shared URLs rank first; remaining results use reciprocal ranks, not provider blocks", () => {
  const row = (name: string) => ({ title: name, url: `https://example.com/${name}`, date: "", snippet: name });
  const output: SearchOutput = { mode: "parallel", attempts: [], sources: [
    { provider: "exa", results: [row("a"), row("b"), row("shared")] },
    { provider: "deepseek", results: [row("c"), row("shared")] },
  ] };
  const ranked = mergeResults(output);
  assert.deepEqual(ranked.map(r => r.title), ["shared", "a", "c", "b"]);
  assert.deepEqual(ranked[0].providers, ["exa", "deepseek"]);
});

test("DeepSeek groups multiple site filters so OR stays attached to the query", () => {
  const { query } = providers.deepseek.body({ query: "docs", domainFilter: ["a.com", "b.com"] });
  assert.equal(query, "docs (site:a.com OR site:b.com)");
  assert.equal(providers.deepseek.body({ query: "docs", domainFilter: ["a.com"] }).query, "docs site:a.com");
});

test("canonical URLs merge tracking, www and trailing-slash variants but keep hash routes", () => {
  const row = (url: string) => ({ title: url, url, date: "", snippet: "" });
  const output: SearchOutput = { mode: "parallel", attempts: [], sources: [
    { provider: "exa", results: [row("https://www.example.com/docs/?utm_source=x#intro"), row("https://example.com/app#/a")] },
    { provider: "deepseek", results: [row("https://example.com/docs"), row("https://example.com/app#/b")] },
  ] };
  const merged = mergeResults(output);
  assert.equal(merged.length, 3);
  assert.deepEqual(merged[0].providers, ["exa", "deepseek"]);
  assert.equal(merged[0].url, "https://www.example.com/docs/?utm_source=x#intro");
});

test("ranking uses canonical keys for URLs that differ from their canonical form", () => {
  const row = (url: string) => ({ title: url.split("/").pop()!, url, date: "", snippet: "" });
  const output: SearchOutput = { mode: "parallel", attempts: [], sources: [
    { provider: "exa", results: [row("https://www.example.com/a"), row("https://www.example.com/b")] },
    { provider: "deepseek", results: [row("https://example.com/c/?utm_source=x")] },
  ] };
  assert.deepEqual(mergeResults(output).map(r => r.title), ["a", "?utm_source=x", "b"]);
});
