// Small shared helpers: randomness, formatting, deterministic blobs and a
// failure-tolerant JSON POST used for every call to the Next.js internal API.

export const rnd = (min: number, max: number): number => Math.random() * (max - min) + min;
export const rndInt = (min: number, max: number): number => Math.floor(rnd(min, max + 1));
export const jitter = (base: number, spread: number): number => base + (Math.random() * 2 - 1) * spread;
export const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
export const round1 = (v: number): number => Math.round(v * 10) / 10;
export const round4 = (v: number): number => Math.round(v * 10000) / 10000;
export const nowIso = (): string => new Date().toISOString();
export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)] as T;
}

export function fmtUptime(sec: number): string {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return d > 0 ? `${d}d ${h}h ${m}m` : `${h}h ${m}m`;
}

export function fmtBytes(n: number): string {
  if (n >= 1_073_741_824) return `${(n / 1_073_741_824).toFixed(2)} GB`;
  if (n >= 1_048_576) return `${(n / 1_048_576).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${Math.round(n)} B`;
}

/** FNV-1a string hash — used to seed deterministic file blobs. */
export function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Deterministic pseudo-random bytes (xorshift32). Generation is capped at 4 MB
 * so "downloading" a multi-GB file in the sandbox never exhausts memory; the
 * reported sizeBytes still reflects the virtual file size.
 */
export function pseudoBlob(size: number, seed: number, magic?: readonly number[]): Buffer {
  const MAX = 4 * 1024 * 1024;
  const n = Math.max(0, Math.min(size, MAX));
  let s = seed >>> 0 || 0x9e3779b9;
  const next = (): number => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s;
  };
  const buf = Buffer.alloc(n);
  for (let i = 0; i < n; i += 4) {
    const v = next();
    buf[i] = v & 0xff;
    if (i + 1 < n) buf[i + 1] = (v >>> 8) & 0xff;
    if (i + 2 < n) buf[i + 2] = (v >>> 16) & 0xff;
    if (i + 3 < n) buf[i + 3] = (v >>> 24) & 0xff;
  }
  if (magic) for (let i = 0; i < Math.min(magic.length, n); i++) buf[i] = magic[i] as number;
  return buf;
}

/**
 * POST JSON and never throw — used for every Next.js internal call so a
 * missing/unstarted backend can never crash the hub. Returns success flag;
 * callers simply retry on their next natural occasion.
 */
export async function postJson(
  url: string,
  body: unknown,
  headers?: Record<string, string>,
): Promise<boolean> {
  return (await postJsonBody(url, body, headers)) !== null;
}

/**
 * Like postJson but resolves with the parsed response body on HTTP 200
 * (null on any failure). Used where the backend returns useful data, e.g.
 * the rule-engine alerts fired during a heartbeat.
 */
export async function postJsonBody(
  url: string,
  body: unknown,
  headers?: Record<string, string>,
): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(headers ?? {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      console.warn(`[HUB] POST ${url} → HTTP ${res.status} (ignored, will retry)`);
      return null;
    }
    const text = await res.text();
    if (!text) return {};
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[HUB] POST ${url} failed: ${msg} (ignored, will retry)`);
    return null;
  }
}
