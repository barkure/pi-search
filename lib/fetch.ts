import type { SearchCache } from "./cache.ts";
import { requestJson } from "./http.ts";
import { resolveKey, type CredentialReader } from "./credentials.ts";
import { localFetch, parseAllowed, type Lookup } from "./local.ts";
import { providers, SearchError, type Page, type Provider } from "./providers.ts";
import { configuredProviders, type Config } from "./search.ts";

export type FetchedPage = Page & { url: string; provider: Provider | "local"; attempts: string[]; redirect?: string; cached?: boolean };
export type FetchOptions = { fresh?: boolean; cache?: SearchCache; lookup?: Lookup };

export async function fetchPage(input: string, config: Config, signal?: AbortSignal, transport = fetch, readStored?: CredentialReader, options: FetchOptions = {}): Promise<FetchedPage> {
  let url: URL;
  try { url = new URL(input); } catch { throw new Error("Invalid page URL."); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || input.length > 8192) {
    throw new Error("Use an HTTP(S) URL without credentials, at most 8192 characters.");
  }
  const cacheKey = options.cache?.key(["fetch", url.href]);
  if (cacheKey && !options.fresh) {
    const hit = options.cache?.get<FetchedPage>(cacheKey);
    if (hit) return { ...hit, cached: true };
  }
  const remember = (page: FetchedPage) => {
    if (cacheKey && !page.redirect) options.cache?.set(cacheKey, page);
    return page;
  };
  // Providers fetch the target first; this machine only does so when localFetch is enabled.
  const attempts: string[] = [];
  for (const provider of configuredProviders(config)) {
    signal?.throwIfAborted();
    const adapter = providers[provider];
    try {
      const key = await resolveKey(provider, config, signal, readStored);
      const payload = await requestJson(adapter.fetchEndpoint, adapter.headers(key), adapter.fetchBody(url.href, options.fresh), signal, transport);
      signal?.throwIfAborted();
      return remember({ ...adapter.parsePage(payload), url: url.href, provider, attempts });
    } catch (error) {
      signal?.throwIfAborted();
      if (!(error instanceof SearchError)) throw error;
      attempts.push(`${provider}: ${error.message}`);
      if (!error.fallback && error.status !== 404) throw new Error(attempts.join("\n"));
    }
  }
  if (config.localFetch) {
    try {
      const allowed = config.allowedAddresses ? parseAllowed(config.allowedAddresses) : undefined;
      const page = await localFetch(url, signal, transport, options.lookup, allowed);
      if ("redirect" in page) {
        return { title: "Redirect", content: `The page redirects to a different host: ${page.redirect}\nCall web_fetch again with that URL if it is expected.`, url: url.href, provider: "local", attempts, redirect: page.redirect };
      }
      return remember({ ...page, url: url.href, provider: "local", attempts });
    } catch (error) {
      signal?.throwIfAborted();
      if (!(error instanceof SearchError)) throw error;
      attempts.push(`local: ${error.message}`);
    }
  }
  throw new Error(attempts.join("\n"));
}
