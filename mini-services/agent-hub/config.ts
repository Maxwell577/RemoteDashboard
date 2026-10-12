// Environment + endpoint configuration for the agent hub mini-service.
// All values have safe defaults so the hub runs even before Next.js is up.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function num(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function dirFromEnv(v: string | undefined, fallback: string): string {
  if (v && v.trim() !== "") return path.resolve(v.trim());
  return fallback;
}

export const CONFIG = {
  port: num(process.env.HUB_PORT, 3003),
  nextApiUrl: (process.env.NEXT_API_URL ?? "http://127.0.0.1:3000").replace(/\/+$/, ""),
  // Where the Next.js app is reachable for internal relays (defaults to nextApiUrl).
  nextAppUrl: (process.env.NEXT_APP_URL ?? process.env.NEXT_API_URL ?? "http://127.0.0.1:3000").replace(/\/+$/, ""),
  hubToken: process.env.HUB_TOKEN ?? "sentra-dev-token",
  heartbeatSec: num(process.env.HEARTBEAT_SEC, 15),
  // Encrypted recording artifacts land here (repo-root/db/recordings).
  recordingsDir: dirFromEnv(process.env.RECORDINGS_DIR, path.resolve(fileURLToPath(new URL("../../db/recordings", import.meta.url)))),
  chunkMaxPayloadBytes: 256 * 1024,
} as const;

/** Absolute URL for a Next.js internal API route. */
export function nextApi(path: string): string {
  return `${CONFIG.nextApiUrl}${path}`;
}

/** Ensure the recordings directory exists; returns its absolute path. */
export function ensureRecordingsDir(): string {
  fs.mkdirSync(CONFIG.recordingsDir, { recursive: true });
  return CONFIG.recordingsDir;
}
