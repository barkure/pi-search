import { createHash } from "node:crypto";

// Session-local, bounded cache. No credentials or query history are written to disk.
export class SearchCache {
  private entries = new Map<string, { value: unknown; expires: number; bytes: number }>();
  private bytes = 0;
  private ttlMs: number;
  private now: () => number;
  constructor(ttlMs = 300_000, now = Date.now) { this.ttlMs = ttlMs; this.now = now; }
  key(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
  get<T>(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expires <= this.now()) { this.remove(key); return undefined; }
    return structuredClone(entry.value) as T;
  }
  set(key: string, value: unknown): void {
    const bytes = Buffer.byteLength(JSON.stringify(value));
    if (bytes > 8 * 1024 * 1024) return;
    this.remove(key);
    for (const [id, entry] of this.entries) if (entry.expires <= this.now()) this.remove(id);
    while (this.entries.size >= 100 || this.bytes + bytes > 8 * 1024 * 1024) this.remove(this.entries.keys().next().value!);
    this.entries.set(key, { value: structuredClone(value), expires: this.now() + this.ttlMs, bytes });
    this.bytes += bytes;
  }
  clear(): void { this.entries.clear(); this.bytes = 0; }
  private remove(key: string): void {
    this.bytes -= this.entries.get(key)?.bytes ?? 0;
    this.entries.delete(key);
  }
}
