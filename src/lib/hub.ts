// SentraRMM — agent hub client (server-to-server HTTP).
// The Next.js dashboard never talks to agents directly; long-running device
// operations are dispatched through the hub mini-service (port 3003).
// Every helper is failure-tolerant: it never throws, it returns typed results.
import { db } from "@/lib/db";
import { DEFAULT_SETTINGS, type AppSettings } from "@/lib/types";

export interface HubAgent {
  agentId: string;
  hostname?: string;
  connected?: boolean;
  lastSeen?: string | null;
  [key: string]: unknown;
}

export type HubResult<T> = { ok: true; data: T } | { ok: false; error: string };

/** Short connect patience for hub health/agents probes. */
const PROBE_TIMEOUT_MS = 2000;

/** Hub URL precedence: Setting "app" → env HUB_URL → DEFAULT_SETTINGS.hubUrl. */
export async function resolveHubUrl(): Promise<string> {
  try {
    const row = await db.setting.findUnique({ where: { key: "app" } });
    if (row) {
      const parsed = JSON.parse(row.value) as Partial<AppSettings>;
      if (typeof parsed.hubUrl === "string" && parsed.hubUrl.trim() !== "") {
        return parsed.hubUrl.trim();
      }
    }
  } catch {
    // settings row unreadable → fall through to env/default
  }
  return process.env.HUB_URL?.trim() || DEFAULT_SETTINGS.hubUrl;
}

function hubErrorMessage(e: unknown): string {
  if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) {
    return "Hub timeout";
  }
  return "Hub unreachable";
}

function trimUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

/**
 * POST {hubUrl}/dispatch → ask the hub to run an operation on an agent.
 * The hub enforces `timeoutMs` on the agent round-trip; we give the fetch a
 * small grace period on top so the hub can answer with an error envelope.
 */
export async function dispatchToHub<T = unknown>(
  agentId: string,
  type: string,
  payload: Record<string, unknown>,
  meta?: Record<string, unknown>,
  timeoutMs = 20000,
): Promise<HubResult<T>> {
  try {
    const hubUrl = await resolveHubUrl();
    const res = await fetch(`${trimUrl(hubUrl)}/dispatch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ agentId, type, payload, meta, timeoutMs }),
      signal: AbortSignal.timeout(timeoutMs + 5000),
      cache: "no-store",
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { ok: false, error: text.slice(0, 500) || `Hub HTTP ${res.status}` };
    }
    const json = (await res.json()) as { ok?: unknown; data?: unknown; error?: unknown };
    if (json && json.ok === true) {
      return { ok: true, data: json.data as T };
    }
    const errorText =
      typeof json?.error === "string" && json.error.trim() !== "" ? json.error : "Agent error";
    return { ok: false, error: errorText };
  } catch (e) {
    return { ok: false, error: hubErrorMessage(e) };
  }
}

/** GET {hubUrl}/agents → connected agent list, or null when hub is down. */
export async function getHubAgents(): Promise<HubAgent[] | null> {
  try {
    const hubUrl = await resolveHubUrl();
    const res = await fetch(`${trimUrl(hubUrl)}/agents`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      cache: "no-store",
    });
    if (!res.ok) return null;
    const json: unknown = await res.json();
    const list: unknown[] | null = Array.isArray(json)
      ? json
      : json && typeof json === "object" && Array.isArray((json as { agents?: unknown }).agents)
        ? ((json as { agents: unknown[] }).agents)
        : null;
    if (!list) return null;
    return list.filter(
      (a): a is HubAgent => !!a && typeof a === "object" && typeof (a as HubAgent).agentId === "string",
    );
  } catch {
    return null;
  }
}

/** GET {hubUrl}/health → true when the hub answers. */
export async function getHubOnline(): Promise<boolean> {
  try {
    const hubUrl = await resolveHubUrl();
    const res = await fetch(`${trimUrl(hubUrl)}/health`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      cache: "no-store",
    });
    return res.ok;
  } catch {
    return false;
  }
}
