import { providers, SearchError, type Provider } from "./providers.ts";
import type { Config } from "./search.ts";

export type StoredCredential = { type: string; key?: string; env?: Record<string, string> };
export type CredentialReader = (provider: string) => StoredCredential | undefined;
const text = (v: unknown) => typeof v === "string" ? v.trim() : "";

export async function resolveKey(provider: Provider, config: Config, signal?: AbortSignal, readStored?: CredentialReader): Promise<string> {
  signal?.throwIfAborted();
  const adapter = providers[provider];
  const environmentKey = text(process.env[adapter.envKey]);
  let source = environmentKey || text(config[adapter.configKey]);
  let extraEnv: Record<string, string> | undefined;
  if (!source && provider === "deepseek") {
    const stored = readStored?.("deepseek");
    if (stored?.type === "api_key") { source = text(stored.key); extraEnv = stored.env; }
  }
  if (!source) throw new SearchError("API key not configured", true);
  let key = source;
  if (!environmentKey && source.startsWith("$")) {
    const match = /^\$(?:([A-Za-z_][A-Za-z0-9_]*)|\{([A-Za-z_][A-Za-z0-9_]*)\})$/.exec(source);
    if (!match) throw new SearchError("Invalid credential environment reference.");
    key = text(extraEnv?.[match[1] || match[2]] ?? process.env[match[1] || match[2]]);
  }
  if (!key || /[\s\x00-\x1f\x7f]/.test(key) || Buffer.byteLength(key) > 16_384) {
    throw new SearchError("Credential must resolve to one non-empty token.");
  }
  signal?.throwIfAborted();
  return key;
}
