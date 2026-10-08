// Environment + endpoint configuration for the agent hub mini-service.
// All values have safe defaults so the hub runs even before Next.js is up.

function num(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export const CONFIG = {
  port: num(process.env.HUB_PORT, 3003),
  nextApiUrl: (process.env.NEXT_API_URL ?? "http://127.0.0.1:3000").replace(/\/+$/, ""),
  hubToken: process.env.HUB_TOKEN ?? "sentra-dev-token",
  heartbeatSec: num(process.env.HEARTBEAT_SEC, 15),
} as const;

/** Absolute URL for a Next.js internal API route. */
export function nextApi(path: string): string {
  return `${CONFIG.nextApiUrl}${path}`;
}
