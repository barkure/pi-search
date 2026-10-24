import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchPage } from "../lib/fetch.ts";
import { SearchCache } from "../lib/cache.ts";
const config = { exaApiKey: "exa-test", deepseekApiKey: "ds-test" };

test("fetch uses Exa contents API and only requests text when reading a page", async () => {
  const page = await fetchPage("https://example.com/docs", config, undefined, async (url, init) => {
    assert.equal(String(url), "https://api.exa.ai/contents");
    assert.deepEqual(JSON.parse(String(init?.body)), { urls: ["https://example.com/docs"], text: true });
    return Response.json({ results: [{ title: "Docs", text: "Page body" }] });
  });
  assert.equal(page.content, "Page body");
  assert.equal(page.provider, "exa");
});

test("unreadable Exa results fall back to DeepSeek fetch with reused credentials", async () => {
  let calls = 0;
  const page = await fetchPage("https://example.com", { exaApiKey: "exa-test" }, undefined, async (url, init) => {
    calls++;
    if (calls === 1) return Response.json({ results: [] });
    assert.equal(String(url), "https://api.deepseek.com/v1/tools/fetch");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer pi-key");
    return Response.json({ title: "Docs", content: "# Markdown" });
  }, () => ({ type: "api_key", key: "pi-key" }));
  assert.equal(page.provider, "deepseek");
  assert.equal(page.attempts.length, 1);
  assert.equal(calls, 2);
});

test("fetch rejects invalid URLs and respects cancellation", async () => {
  for (const url of ["file:///tmp/a", "https://user:pass@example.com", "invalid"]) {
    await assert.rejects(fetchPage(url, config, undefined, async () => { assert.fail("must not fetch"); }));
  }
  const controller = new AbortController(); controller.abort();
  await assert.rejects(fetchPage("https://example.com", config, controller.signal), { name: "AbortError" });
});

test("404 from one provider tries the next by status, not message text", async () => {
  let calls = 0;
  const page = await fetchPage("https://example.com", config, undefined, async () => {
    calls++;
    return calls === 1 ? new Response("", { status: 404 }) : Response.json({ title: "Docs", content: "Body" });
  });
  assert.equal(page.provider, "deepseek");
  assert.deepEqual(page.attempts, ["exa: HTTP 404"]);
});

test("fresh requests a live Exa crawl; pages are cached unless fresh", async () => {
  const cache = new SearchCache();
  let calls = 0;
  const transport = async (_url: string | URL | Request, init?: RequestInit) => {
    calls++;
    return Response.json({ results: [{ title: "Docs", text: `Body ${JSON.parse(String(init?.body)).maxAgeHours ?? "cached"}` }] });
  };
  assert.equal((await fetchPage("https://example.com", config, undefined, transport, undefined, { cache })).content, "Body cached");
  const hit = await fetchPage("https://example.com", config, undefined, transport, undefined, { cache });
  assert.equal(hit.cached, true);
  assert.equal(calls, 1);
  assert.equal((await fetchPage("https://example.com", config, undefined, transport, undefined, { cache, fresh: true })).content, "Body 0");
  assert.equal(calls, 2);
});

test("local fetch is opt-in, converts HTML and reports cross-host redirects", async () => {
  const lookup = async () => ["93.184.216.34"];
  const failing = async (url: string | URL | Request) => String(url).includes("api.") ? new Response("", { status: 503 }) : null;
  await assert.rejects(fetchPage("https://example.com", { exaApiKey: "k", providers: ["exa"] }, undefined, async () => new Response("", { status: 503 }), undefined, { lookup }));
  const local = { exaApiKey: "k", providers: ["exa" as const], localFetch: true };
  const page = await fetchPage("https://example.com", local, undefined, async url => await failing(url) ?? new Response(
    "<html><head><title>T &amp; C</title><script>evil()</script></head><body><h1>Hi</h1><p>One&nbsp;two</p></body></html>",
    { headers: { "content-type": "text/html" } }), undefined, { lookup });
  assert.equal(page.provider, "local");
  assert.equal(page.title, "T & C");
  assert.equal(page.content, "# Hi\n\nOne two");
  const moved = await fetchPage("https://example.com", local, undefined, async url => await failing(url) ?? new Response(null, { status: 301, headers: { location: "https://other.org/x" } }), undefined, { lookup });
  assert.equal(moved.redirect, "https://other.org/x");
});

test("local fetch refuses private addresses", async () => {
  const local = { exaApiKey: "k", providers: ["exa" as const], localFetch: true };
  for (const address of ["127.0.0.1", "10.1.2.3", "::1", "::ffff:192.168.0.1", "169.254.169.254"]) {
    await assert.rejects(fetchPage("https://internal.example", local, undefined, async url => {
      assert.match(String(url), /api\./);
      return new Response("", { status: 503 });
    }, undefined, { lookup: async () => [address] }), /private or loopback/);
  }
});

test("fake-ip addresses from TUN proxies need allowedAddresses", async () => {
  const transport = async (url: string | URL | Request) => String(url).includes("api.")
    ? new Response("", { status: 503 }) : new Response("ok", { headers: { "content-type": "text/plain" } });
  const local = { exaApiKey: "k", providers: ["exa" as const], localFetch: true };
  const lookup = async () => ["198.18.0.134"];
  await assert.rejects(fetchPage("https://example.com", local, undefined, transport, undefined, { lookup }), /198\.18\.0\.134; add it/);
  const page = await fetchPage("https://example.com", { ...local, allowedAddresses: ["198.18.0.0/15"] }, undefined, transport, undefined, { lookup });
  assert.equal(page.content, "ok");
});

test("allowedAddresses permits listed private IPs and ranges only", async () => {
  const local = { exaApiKey: "k", providers: ["exa" as const], localFetch: true, allowedAddresses: ["127.0.0.1", "192.168.1.0/24"] };
  const transport = async (url: string | URL | Request) => String(url).includes("api.")
    ? new Response("", { status: 503 }) : new Response("internal docs", { headers: { "content-type": "text/plain" } });
  for (const address of ["127.0.0.1", "192.168.1.20", "::ffff:192.168.1.20"]) {
    const page = await fetchPage("http://intranet.example/docs", local, undefined, transport, undefined, { lookup: async () => [address] });
    assert.equal(page.content, "internal docs");
  }
  for (const address of ["192.168.2.1", "10.0.0.1"]) {
    await assert.rejects(fetchPage("http://intranet.example/docs", local, undefined, transport, undefined, { lookup: async () => [address] }), new RegExp(`address ${address.replace(/\./g, "\\.")}; add it to allowedAddresses`));
  }
});

test("allowedAddresses rejects malformed entries", async () => {
  const { parseAllowed } = await import("../lib/local.ts");
  for (const bad of [["localhost"], ["10.0.0.0/33"], ["10.0.0.0/8/1"], ["10.0.0.0/x"], "10.0.0.1", [1]]) assert.throws(() => parseAllowed(bad), /allowedAddresses/);
  assert.doesNotThrow(() => parseAllowed(["::1", "fd00::/8", " 10.0.0.0/8 "]));
});
