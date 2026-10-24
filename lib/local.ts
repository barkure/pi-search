import { lookup as dnsLookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { SearchError, type Page } from "./providers.ts";

export type Lookup = (host: string) => Promise<string[]>;
export type LocalPage = Page | { redirect: string };
const defaultLookup: Lookup = async host => (await dnsLookup(host, { all: true, verbatim: true })).map(a => a.address);
const maxBytes = 5 * 1024 * 1024;

// TUN proxies in fake-ip mode (Clash, Surge, sing-box) resolve every host into 198.18.0.0/15;
// users of those list the range in allowedAddresses.
const blocked = new BlockList();
for (const [net, prefix] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 3]] as const) blocked.addSubnet(net, prefix, "ipv4");
for (const [net, prefix] of [["::", 127], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8]] as const) blocked.addSubnet(net, prefix, "ipv6");

const unmap = (address: string) => /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1] ?? address;
const inList = (list: BlockList, address: string) => {
  const family = isIP(address);
  return !!family && list.check(address, family === 4 ? "ipv4" : "ipv6");
};

export function isPrivateAddress(address: string): boolean {
  const ip = unmap(address);
  return !isIP(ip) || inList(blocked, ip);
}

// Accepts IPs or CIDR ranges, e.g. "192.168.1.10", "10.0.0.0/8", "::1".
export function parseAllowed(entries: unknown): BlockList {
  if (!Array.isArray(entries)) throw new Error("allowedAddresses must be a list of IPs or CIDR ranges.");
  const list = new BlockList();
  for (const entry of entries) {
    const [ip, prefix, extra] = typeof entry === "string" ? entry.trim().split("/") : [];
    const family = ip ? isIP(ip) : 0;
    const bits = prefix === undefined ? (family === 4 ? 32 : 128) : Number(prefix);
    if (!family || extra !== undefined || !Number.isInteger(bits) || bits < 0 || bits > (family === 4 ? 32 : 128) || (prefix !== undefined && !/^\d+$/.test(prefix))) {
      throw new Error(`allowedAddresses: invalid IP or CIDR range ${JSON.stringify(entry)}.`);
    }
    list.addSubnet(ip, bits, family === 4 ? "ipv4" : "ipv6");
  }
  return list;
}

// Best-effort guard: rejects hosts that resolve to loopback, private or link-local networks not in allowed.
async function assertPublic(url: URL, lookup: Lookup, allowed?: BlockList): Promise<void> {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [host] : await lookup(host).catch(() => { throw new SearchError("DNS lookup failed.", true); });
  if (!addresses.length) throw new SearchError("DNS returned no addresses.", true);
  const refused = addresses.find(a => isPrivateAddress(a) && !(allowed && inList(allowed, unmap(a))));
  if (refused) throw new SearchError(`Local fetch refuses private or loopback address ${refused}; add it to allowedAddresses to permit.`);
}

const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
function decode(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, name: string) => {
    if (name[0] !== "#") return entities[name.toLowerCase()] ?? match;
    const code = name[1].toLowerCase() === "x" ? parseInt(name.slice(2), 16) : Number(name.slice(1));
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
  });
}

export function htmlToText(html: string): Page {
  const title = decode(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "").replace(/\s+/g, " ").trim();
  const body = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|noscript|svg|template|head|nav|footer)\b[\s\S]*?<\/\1>/gi, "")
    .replace(/<h([1-6])[^>]*>/gi, (_, level: string) => `\n\n${"#".repeat(Number(level))} `)
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<(br|hr)\b[^>]*>/gi, "\n")
    .replace(/<\/(p|div|section|article|h[1-6]|ul|ol|table|tr|pre|blockquote)>/gi, "\n\n")
    .replace(/<(td|th)\b[^>]*>/gi, " | ")
    .replace(/<[^>]+>/g, "");
  const content = decode(body).replace(/[ \t\r\f\v]+/g, " ").replace(/ *\n */g, "\n").replace(/^- *$/gm, "").replace(/\n{3,}/g, "\n\n").trim();
  return { title, content };
}

async function readLimited(response: Response): Promise<string> {
  if (Number(response.headers.get("content-length")) > maxBytes) {
    await response.body?.cancel();
    throw new SearchError("Page exceeds 5 MB.");
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body ?? []) {
    size += chunk.byteLength;
    if (size > maxBytes) throw new SearchError("Page exceeds 5 MB.");
    chunks.push(chunk);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

// Same-host redirects are followed; cross-host redirects are returned so the caller decides.
export async function localFetch(url: URL, signal?: AbortSignal, transport = fetch, lookup = defaultLookup, allowed?: BlockList): Promise<LocalPage> {
  const timeout = AbortSignal.timeout(30_000);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let current = url;
  for (let hop = 0; hop <= 5; hop++) {
    await assertPublic(current, lookup, allowed);
    let response: Response;
    try {
      response = await transport(current.href, { redirect: "manual", signal: combined, headers: { Accept: "text/html, text/plain, text/markdown, application/json;q=0.9, */*;q=0.1" } });
    } catch {
      signal?.throwIfAborted();
      throw new SearchError(timeout.aborted ? "Request timed out after 30s." : "Network request failed.", true);
    }
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel();
      const location = response.headers.get("location");
      if (!location) throw new SearchError(`HTTP ${response.status} without Location.`);
      const next = new URL(location, current);
      if (!["http:", "https:"].includes(next.protocol)) throw new SearchError("Redirect to a non-HTTP(S) URL.");
      if (next.host !== current.host) return { redirect: next.href };
      current = next;
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new SearchError(`HTTP ${response.status}`, response.status === 429 || response.status >= 500, response.status);
    }
    const type = response.headers.get("content-type") ?? "";
    if (type && !/^(text\/|application\/(json|xml|xhtml\+xml))/i.test(type)) {
      await response.body?.cancel();
      throw new SearchError(`Unsupported content type: ${type.split(";")[0]}.`);
    }
    const raw = await readLimited(response);
    const page = /html/i.test(type) || (!type && /^\s*</.test(raw)) ? htmlToText(raw) : { title: "", content: raw.trim() };
    if (!page.content) throw new SearchError("No readable page content returned.");
    return page;
  }
  throw new SearchError("Too many redirects.");
}
