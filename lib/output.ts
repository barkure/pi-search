import { rmSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatResults, mergeResults, type SearchOutput } from "./search.ts";

// The root is memoized as a promise so concurrent first writes share one directory;
// every root ever created is tracked so cleanupOutputs() removes them all.
let root: Promise<string> | undefined;
const roots = new Set<string>();

function rootDirectory(): Promise<string> {
  return root ??= mkdtemp(join(tmpdir(), "pi-search-")).then(
    path => { roots.add(path); return path; },
    error => { root = undefined; throw error; },
  );
}

async function outputDirectory(): Promise<string> {
  const current = rootDirectory();
  try { return await mkdtemp(join(await current, "r-")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (root === current) root = undefined;
    return mkdtemp(join(await rootDirectory(), "r-"));
  }
}

export function cleanupOutputs(): void {
  for (const path of roots) rmSync(path, { recursive: true, force: true });
  roots.clear();
  root = undefined;
}

export async function prepareText(full: string, preview = full): Promise<{ content: string; path?: string }> {
  if (preview === full && preview.length <= 16_000) return { content: preview };
  const directory = await outputDirectory();
  const path = join(directory, "results.txt");
  await writeFile(path, full, { mode: 0o600 });
  const prefix = `Full results: ${path}\nUse read with offset/limit for complete content.\n\n`;
  const suffix = "\n[Preview ends]";
  const budget = 16_000 - prefix.length;
  const content = preview.length > budget ? `${preview.slice(0, budget - suffix.length)}${suffix}` : preview;
  return { content: prefix + content, path };
}

export async function prepareOutput(query: string, output: SearchOutput): Promise<{ content: string; path?: string }> {
  const results = mergeResults(output);
  const full = formatResults(query, output, Infinity, results);
  const preview = formatResults(query, output, Math.min(400, Math.floor(8000 / Math.max(1, results.length))), results);
  return prepareText(full, preview);
}
