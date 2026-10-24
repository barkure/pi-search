import { domainToASCII } from "node:url";
import type { Options, Result } from "./search.ts";

export class SearchError extends Error {
  fallback: boolean;
  status?: number;
  constructor(message: string, fallback = false, status?: number) { super(message); this.fallback = fallback; this.status = status; }
}
const days = { day: 1, week: 7, month: 30, year: 365 };
const text = (v: unknown): string => typeof v === "string" ? v.trim() : "";

export function normalizeDomain(raw: string): string {
  const input = raw.trim().replace(/^-/, "").replace(/\.$/, "");
  if (/[\s/@:#?\\]/.test(input)) throw new SearchError("domainFilter expects a domain, not a URL or path.");
  const wildcard = input.startsWith("*.");
  const domain = domainToASCII(wildcard ? input.slice(2) : input).toLowerCase();
  if (!/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(domain) || domain.length > 253) {
    throw new SearchError("domainFilter accepts domains or *.subdomains, optionally prefixed with '-'.");
  }
  return `${wildcard ? "*." : ""}${domain}`;
}

export function matchesDomains(url: string, domains: string[] = []): boolean {
  const host = new URL(url).hostname.toLowerCase();
  const matches = (raw: string) => {
    const domain = normalizeDomain(raw);
    const base = domain.replace(/^\*\./, "");
    return host.endsWith(`.${base}`) || (!domain.startsWith("*.") && host === base);
  };
  const includes = domains.filter(d => !d.trim().startsWith("-"));
  return (!includes.length || includes.some(matches)) && !domains.filter(d => d.trim().startsWith("-")).some(matches);
}

function filters(options: Options) {
  const include: string[] = [], exclude: string[] = [];
  for (const raw of options.domainFilter ?? []) {
    (raw.trim().startsWith("-") ? exclude : include).push(normalizeDomain(raw));
  }
  const after = options.recencyFilter
    ? new Date(Date.now() - days[options.recencyFilter] * 86_400_000).toISOString() : undefined;
  return { include, exclude, after };
}

export type Page = { title: string; content: string };
function page(title: unknown, content: unknown): Page {
  if (!text(content)) throw new SearchError("No readable page content returned.", true);
  return { title: text(title), content: text(content) };
}

export const providers = {
  exa: {
    endpoint: "https://api.exa.ai/search",
    configKey: "exaApiKey",
    envKey: "EXA_API_KEY",
    headers: (key: string) => ({ "x-api-key": key }),
    body(options: Options) {
      const { include, exclude, after } = filters(options);
      return {
        query: options.query.trim(), type: "auto", numResults: options.numResults ?? 5,
        contents: { highlights: true },
        ...(include.length ? { includeDomains: include.map(d => d.replace(/^\*\./, "")) } : {}),
        ...(exclude.length ? { excludeDomains: exclude.filter(d => !d.startsWith("*.")) } : {}),
        ...(after ? { startPublishedDate: after } : {}),
      };
    },
    parse: parseResults,
    fetchEndpoint: "https://api.exa.ai/contents",
    // maxAgeHours: 0 forces a live crawl instead of Exa's cached copy.
    fetchBody: (url: string, fresh?: boolean) => ({ urls: [url], text: true, ...(fresh ? { maxAgeHours: 0 } : {}) }),
    parsePage(value: unknown): Page {
      const first = (value as { results?: { title?: unknown; text?: unknown }[] })?.results?.[0];
      return page(first?.title, first?.text);
    },
  },
  deepseek: {
    endpoint: "https://api.deepseek.com/v1/tools/search",
    configKey: "deepseekApiKey",
    envKey: "DEEPSEEK_API_KEY",
    headers: (key: string) => ({ Authorization: `Bearer ${key}` }),
    body(options: Options) {
      const { include, exclude, after } = filters(options);
      const sites = include.map(d => `site:${d.replace(/^\*\./, "")}`);
      // Parenthesize alternatives so OR cannot detach the query from the first site.
      const query = [options.query.trim(), sites.length > 1 ? `(${sites.join(" OR ")})` : sites[0] ?? "",
        ...exclude.filter(d => !d.startsWith("*.")).map(d => `-site:${d}`), after ? `after:${after.slice(0, 10)}` : "",
      ].filter(Boolean).join(" ");
      if ([...query].length > 128) throw new SearchError("DeepSeek query exceeds 128 characters including filters.", true);
      return { query, count: options.numResults ?? 5, need_content: false };
    },
    parse: parseResults,
    fetchEndpoint: "https://api.deepseek.com/v1/tools/fetch",
    fetchBody: (url: string, _fresh?: boolean) => ({ url }),
    parsePage(value: unknown): Page {
      const result = value as { title?: unknown; content?: unknown } | null;
      return page(result?.title, result?.content);
    },
  },
} as const;

export type Provider = keyof typeof providers;
export const providerNames = Object.keys(providers) as Provider[];

function parseResults(payload: unknown, count: number): Result[] {
  if (!payload || typeof payload !== "object" || !Array.isArray((payload as { results?: unknown }).results)) {
    throw new SearchError("Invalid search response: missing results array.", true);
  }
  const entries = (payload as { results: unknown[] }).results;
  const results: Result[] = [], seen = new Set<string>();
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    let url: URL;
    try { url = new URL(text(row.url)); } catch { continue; }
    if (!['http:', 'https:'].includes(url.protocol) || seen.has(url.href)) continue;
    seen.add(url.href);
    const highlights = Array.isArray(row.highlights) ? row.highlights.map(text).filter(Boolean).join("\n") : "";
    results.push({
      title: text(row.title) || url.href, url: url.href,
      date: text(row.publishedDate) || text(row.date),
      snippet: highlights || text(row.summary) || text(row.snippet) || text(row.text),
    });
    if (results.length >= count) break;
  }
  if (entries.length && !results.length) throw new SearchError("Invalid search response: no usable URLs.", true);
  return results;
}

