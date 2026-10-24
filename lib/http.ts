import { setTimeout as delay } from "node:timers/promises";
import { SearchError } from "./providers.ts";

const transientCodes = new Set(["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "ECONNREFUSED", "EPIPE", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_SOCKET"]);
export function isTransientNetworkError(error: unknown): boolean {
  const seen = new Set<unknown>();
  for (let current = error; current && typeof current === "object" && !seen.has(current); current = (current as { cause?: unknown }).cause) {
    seen.add(current);
    if (transientCodes.has(String((current as { code?: unknown }).code))) return true;
  }
  return false;
}

export function retryDelay(value: string | null, now = Date.now()): number {
  if (value !== null && /^\d+(?:\.\d+)?$/.test(value.trim())) return Number(value) * 1000;
  const date = value && /[a-z]/i.test(value) ? Date.parse(value) : NaN;
  return Number.isFinite(date) ? Math.max(0, date - now) : 500;
}

export async function fetchWithRetry(url: string, init: RequestInit, deadline: number, transport = fetch): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    init.signal?.throwIfAborted();
    if (Date.now() >= deadline) throw new SearchError("Request deadline reached.", true);
    let wait = 500;
    let reason = "Transient network error";
    try {
      const response = await transport(url, init);
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt === 1) return response;
      wait = retryDelay(response.headers.get("Retry-After"));
      reason = `HTTP ${response.status}`;
      await response.body?.cancel();
    } catch (error) {
      init.signal?.throwIfAborted();
      if (attempt === 1 || !isTransientNetworkError(error)) throw error;
    }
    if (wait >= deadline - Date.now()) throw new SearchError(`${reason}: retry delay exceeds remaining request budget.`, true);
    await delay(wait, undefined, { signal: init.signal ?? undefined });
  }
}

export async function requestJson(url: string, headers: Record<string, string>, body: unknown, signal?: AbortSignal, transport = fetch): Promise<unknown> {
  const deadline = Date.now() + 30_000;
  const timeout = AbortSignal.timeout(30_000);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  try {
    const response = await fetchWithRetry(url, {
      method: "POST", redirect: "error", headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body), signal: combined,
    }, deadline, transport);
    if (!response.ok) {
      await response.body?.cancel();
      throw new SearchError(`HTTP ${response.status}`, [402, 429].includes(response.status) || response.status >= 500, response.status);
    }
    try { return await response.json(); }
    catch {
      combined.throwIfAborted();
      throw new SearchError("Could not read JSON response.", true);
    }
  } catch (error) {
    signal?.throwIfAborted();
    if (error instanceof SearchError) throw error;
    throw new SearchError(timeout.aborted ? "Request timed out after 30s." : "Network request failed.", true);
  }
}
