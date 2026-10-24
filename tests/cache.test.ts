import { test } from "node:test";
import assert from "node:assert/strict";
import { SearchCache } from "../lib/cache.ts";
import { search } from "../lib/search.ts";

test("cache expires, returns independent values and evicts oldest entries", () => {
  let now = 0;
  const cache = new SearchCache(1000, () => now);
  cache.set("key", { n: 1 });
  cache.get<{ n: number }>("key")!.n = 2;
  assert.equal(cache.get<{ n: number }>("key")!.n, 1);
  now = 1000;
  assert.equal(cache.get("key"), undefined);
  for (let i = 0; i < 101; i++) cache.set(String(i), i);
  assert.equal(cache.get("0"), undefined);
  assert.equal(cache.get("100"), 100);
  cache.clear();
  assert.equal(cache.get("100"), undefined);
});

test("same search reuses results, changed query/filter/key misses, empty results are not cached", async () => {
  let calls = 0;
  const cache = new SearchCache();
  const config = { providers: ["exa"] as "exa"[], exaApiKey: "test" };
  const transport = async () => { calls++; return Response.json({ results: [{ url: "https://example.com", title: "Docs" }] }); };
  await search({ query: "docs" }, config, undefined, transport, undefined, cache);
  const hit = await search({ query: "docs" }, config, undefined, transport, undefined, cache);
  assert.equal(calls, 1);
  assert.equal(hit.sources[0].cached, true);
  await search({ query: "other" }, config, undefined, transport, undefined, cache);
  await search({ query: "docs", domainFilter: ["example.com"] }, config, undefined, transport, undefined, cache);
  await search({ query: "docs" }, { ...config, exaApiKey: "rotated" }, undefined, transport, undefined, cache);
  assert.equal(calls, 4);
  const empty = async () => { calls++; return Response.json({ results: [] }); };
  await search({ query: "missing" }, config, undefined, empty, undefined, cache);
  await search({ query: "missing" }, config, undefined, empty, undefined, cache);
  assert.equal(calls, 6);
});
