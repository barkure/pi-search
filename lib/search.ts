import type { SearchCache } from "./cache.ts";
import { requestJson } from "./http.ts";
import { resolveKey, type CredentialReader } from "./credentials.ts";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { providers, providerNames, matchesDomains, SearchError, type Provider } from "./providers.ts";
import { parseAllowed } from "./local.ts";

export type Mode = "fallback" | "parallel";
type KeyName = (typeof providers)[Provider]["configKey"];
export type Config = { providers?: Provider[]; mode?: Mode; localFetch?: boolean; allowedAddresses?: string[]; extractModel?: string } & Partial<Record<KeyName, string>>;
export type Options = {
  query: string;
  numResults?: number;
  domainFilter?: string[];
  recencyFilter?: "day" | "week" | "month" | "year";
};
export type Result = { title: string; url: string; date: string; snippet: string };
export type Source = { provider: Provider; results: Result[]; cached?: boolean };
export type SearchOutput = { mode: Mode; sources: Source[]; attempts: string[] };
const text = (v: unknown): string => typeof v === "string" ? v.trim() : "";

function validateProviders(value: unknown): asserts value is Provider[] {
  if (!Array.isArray(value) || !value.length || new Set(value).size !== value.length ||
    value.some(p => typeof p !== "string" || !providerNames.includes(p as Provider))) {
    throw new Error(`providers must be a non-empty list of ${providerNames.join(", ")}, without duplicates.`);
  }
}

export function configuredProviders(config: Config): Provider[] {
  const route = config.providers ?? providerNames;
  validateProviders(route);
  return route;
}

function validateMode(value: unknown): asserts value is Mode {
  if (value !== "fallback" && value !== "parallel") throw new Error("mode must be fallback or parallel.");
}

export async function loadConfig(): Promise<Config> {
  const path = process.env.PI_SEARCH_CONFIG || join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "search.json");
  let value: unknown = {};
  try { value = JSON.parse(await readFile(path, "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(`Cannot read ${path}; check JSON syntax and file permissions.`);
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Search config must be an object.");
  const config = value as Config;
  if (config.providers !== undefined) validateProviders(config.providers);
  if (config.mode !== undefined) validateMode(config.mode);
  if (config.localFetch !== undefined && typeof config.localFetch !== "boolean") throw new Error("localFetch must be a boolean.");
  if (config.allowedAddresses !== undefined) parseAllowed(config.allowedAddresses);
  if (config.extractModel !== undefined && !/^[^/\s]+\/\S+$/.test(String(config.extractModel))) throw new Error("extractModel must be provider/model-id.");
  for (const { configKey } of Object.values(providers)) {
    if (config[configKey] !== undefined && typeof config[configKey] !== "string") throw new Error(`${configKey} must be a string.`);
    config[configKey] = text(config[configKey]);
  }
  return config;
}

async function searchProvider(provider: Provider, options: Options, config: Config, signal: AbortSignal | undefined, transport: typeof fetch, readStored?: CredentialReader, cache?: SearchCache, refresh?: boolean): Promise<Source> {
  signal?.throwIfAborted();
  const adapter = providers[provider];
  const key = await resolveKey(provider, config, signal, readStored);
  const body = adapter.body(options);
  const cacheKey = cache?.key([provider, key, { ...options, query: options.query.trim() }]);
  // refresh skips the read but still stores, so later plain queries see the new results.
  const hit = cacheKey && !refresh ? cache?.get<Source>(cacheKey) : undefined;
  if (hit) return { ...hit, cached: true };
  const payload = await requestJson(adapter.endpoint, adapter.headers(key), body, signal, transport);
  signal?.throwIfAborted();
  const source: Source = { provider, results: adapter.parse(payload, options.numResults ?? 5).filter(r => matchesDomains(r.url, options.domainFilter)) };
  if (cacheKey && source.results.length) cache?.set(cacheKey, source);
  return source;
}

export async function search(options: Options, config: Config, signal?: AbortSignal, transport = fetch, readStored?: CredentialReader, cache?: SearchCache, refresh?: boolean): Promise<SearchOutput> {
  if (!options.query.trim()) throw new SearchError("query must not be empty.");
  if (!Number.isInteger(options.numResults ?? 5) || (options.numResults ?? 5) < 1 || (options.numResults ?? 5) > 20) {
    throw new SearchError("numResults must be an integer from 1 to 20.");
  }
  const route = configuredProviders(config);
  const mode = config.mode ?? "fallback";
  validateMode(mode);
  signal?.throwIfAborted();
  const attempts: string[] = [];
  if (mode === "parallel") {
    // Keep provider order, even when requests complete in a different order.
    const settled = await Promise.allSettled(route.map(provider => searchProvider(provider, options, config, signal, transport, readStored, cache, refresh)));
    signal?.throwIfAborted();
    const sources: Source[] = [];
    settled.forEach((result, i) => {
      if (result.status === "fulfilled") sources.push(result.value);
      else attempts.push(`${route[i]}: ${result.reason instanceof SearchError ? result.reason.message : "Search failed."}`);
    });
    if (!sources.length) throw new Error(attempts.join("\n"));
    return { mode, sources, attempts };
  }
  let empty: Source | undefined;
  for (const provider of route) {
    try {
      const source = await searchProvider(provider, options, config, signal, transport, readStored, cache, refresh);
      if (source.results.length) return { mode, sources: [source], attempts };
      // Zero results is worth a second opinion from the next provider.
      attempts.push(`${provider}: No results.`);
      empty ??= source;
    } catch (error) {
      signal?.throwIfAborted();
      if (!(error instanceof SearchError)) throw error;
      attempts.push(`${provider}: ${error.message}`);
      if (!error.fallback) throw new Error(attempts.join("\n"));
    }
  }
  if (empty) return { mode, sources: [empty], attempts };
  throw new Error(attempts.join("\n"));
}

const trackingParams = /^(utm_\w+|gclid|fbclid|msclkid|mc_[ce]id|ref_src)$/i;

// Dedup key only; displayed URLs keep their original form.
export function canonicalUrl(raw: string): string {
  const url = new URL(raw);
  url.hostname = url.hostname.replace(/^www\./, "");
  for (const name of [...url.searchParams.keys()]) if (trackingParams.test(name)) url.searchParams.delete(name);
  // Hash-routed apps (#/path, #!/path) address distinct content; plain anchors do not.
  if (!/^#!?\//.test(url.hash)) url.hash = "";
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "");
  return url.href;
}

export type MergedResult = { title: string; url: string; providers: Provider[]; dates: string[]; excerpts: { text: string; providers: Provider[] }[] };

export function mergeResults(output: SearchOutput): MergedResult[] {
  const merged = new Map<string, MergedResult>();
  const scores = new Map<string, number>();
  for (const source of output.sources) for (const [rank, result] of source.results.entries()) {
    const url = canonicalUrl(result.url);
    let row = merged.get(url);
    if (!row) {
      row = { title: result.title, url: new URL(result.url).href, providers: [], dates: [], excerpts: [] };
      merged.set(url, row);
    }
    if (!row.providers.includes(source.provider)) {
      row.providers.push(source.provider);
      scores.set(url, (scores.get(url) ?? 0) + 1 / (60 + rank + 1));
    }
    if (result.date && !row.dates.includes(result.date)) row.dates.push(result.date);
    const snippet = result.snippet.trim();
    if (!snippet) continue;
    const existing = row.excerpts.find(e => e.text.replace(/\s+/g, " ") === snippet.replace(/\s+/g, " "));
    if (existing) {
      if (!existing.providers.includes(source.provider)) existing.providers.push(source.provider);
    } else row.excerpts.push({ text: snippet, providers: [source.provider] });
  }
  // Scores are keyed by canonical URL, so sort entries rather than displayed rows.
  return [...merged].sort(([ka, a], [kb, b]) => b.providers.length - a.providers.length || scores.get(kb)! - scores.get(ka)!).map(([, row]) => row);
}

export function formatResults(query: string, output: SearchOutput, snippetChars = Infinity, results = mergeResults(output)): string {
  const body = results.length ? untrusted(results.map((r, i) => [
    `${i + 1}. ${r.title}\n${r.url}\nSources: ${r.providers.join(", ")}`,
    ...(r.dates.length ? [`Published: ${r.dates.join(", ")}`] : []),
    ...r.excerpts.map(e => {
      const budget = Math.floor(snippetChars / Math.max(1, r.excerpts.length));
      const excerpt = e.text.length > budget ? `${e.text.slice(0, Math.max(0, budget - 1)).trimEnd()}…` : e.text;
      return `[${e.providers.join(", ")}] ${excerpt}`;
    }),
  ].join("\n")).join("\n\n"), "web search results") : "No results found.";
  return [
    `Query: ${query}\nMode: ${output.mode}\nProviders: ${output.sources.map(s => s.provider).join(", ")}`,
    ...(output.attempts.length ? [`Failed or skipped providers:\n${output.attempts.join("\n")}`] : []),
    body,
  ].join("\n\n");
}

// Marks third-party text as data so instructions inside it are not mistaken for the user's.
export function untrusted(text: string, source: string): string {
  const safe = text.replace(/<\/?untrusted_web_content/gi, m => m.replace("<", "&lt;"));
  return `<untrusted_web_content source="${source.replace(/"/g, "%22")}">\n${safe}\n</untrusted_web_content>`;
}
