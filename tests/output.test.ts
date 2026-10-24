import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { prepareOutput } from "../lib/output.ts";
import type { SearchOutput } from "../lib/search.ts";

test("previews cover later results and keep full evidence in a private file", async () => {
  const output: SearchOutput = { mode: "parallel", attempts: [], sources: [{ provider: "exa", results: Array.from({ length: 5 }, (_, i) => ({
    title: `Result ${i}`, url: `https://example.com/${i}`, date: "", snippet: `Evidence ${i} ` + "long text ".repeat(500) + ` END-${i}`,
  })) }] };
  const result = await prepareOutput("docs", output);
  assert.ok(result.path);
  try {
    assert.ok(result.content.length < 3500);
    assert.match(result.content, /Result 4/);
    assert.doesNotMatch(result.content, /END-4/);
    assert.match(await readFile(result.path, "utf8"), /END-4/);
    assert.equal((await stat(result.path)).mode & 0o777, 0o600);
    assert.equal((await stat(dirname(result.path))).mode & 0o777, 0o700);
  } finally { await rm(dirname(result.path), { recursive: true }); }
});

test("short output stays inline without unnecessary files", async () => {
  const output: SearchOutput = { mode: "fallback", attempts: [], sources: [{ provider: "exa", results: [{ title: "Docs", url: "https://example.com", date: "", snippet: "Short evidence" }] }] };
  const result = await prepareOutput("docs", output);
  assert.equal(result.path, undefined);
  assert.match(result.content, /Short evidence/);
});

test("full output limit includes file prefix and truncation marker", async () => {
  const output: SearchOutput = { mode: "fallback", attempts: [], sources: [{ provider: "exa", results: [{ title: "title".repeat(4000), url: "https://example.com", date: "", snippet: "short" }] }] };
  const result = await prepareOutput("docs", output);
  assert.ok(result.path);
  try {
    assert.ok(result.content.length <= 16_000);
    assert.match(result.content, /\[Preview ends\]$/);
    assert.ok((await readFile(result.path, "utf8")).length > 16_000);
  } finally { await rm(dirname(result.path), { recursive: true }); }
});

test("cleanupOutputs removes every file written in the session", async () => {
  const { cleanupOutputs, prepareText } = await import("../lib/output.ts");
  const a = await prepareText("x".repeat(20_000));
  const b = await prepareText("y".repeat(20_000));
  assert.equal(dirname(dirname(a.path!)), dirname(dirname(b.path!)));
  cleanupOutputs();
  await assert.rejects(stat(a.path!));
  await assert.rejects(stat(dirname(dirname(b.path!))));
});

test("concurrent first writes share one root and cleanup removes it", async () => {
  const { cleanupOutputs, prepareText } = await import("../lib/output.ts");
  cleanupOutputs();
  const paths = await Promise.all(Array.from({ length: 5 }, (_, i) => prepareText(`${i}`.repeat(20_000))));
  assert.equal(new Set(paths.map(p => dirname(dirname(p.path!)))).size, 1);
  cleanupOutputs();
  for (const p of paths) await assert.rejects(stat(p.path!));
});
