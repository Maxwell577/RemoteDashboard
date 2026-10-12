// GET /api/hub/status → { online: boolean, agents: HubAgent[], activeStreams: number }
// Fetches the hub's /agents registry directly so the payload can carry the
// v0.3 activeStreams count; falls back to the lib helpers when the hub is old
// or unreachable.
import type { NextRequest } from "next/server";
import { err, ok } from "@/lib/api-helpers";
import { getHubAgents, getHubOnline, resolveHubUrl } from "@/lib/hub";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest) {
  try {
    try {
      const hubUrl = (await resolveHubUrl()).replace(/\/+$/, "");
      const res = await fetch(`${hubUrl}/agents`, {
        signal: AbortSignal.timeout(2500),
        cache: "no-store",
      });
      if (res.ok) {
        const json = (await res.json()) as {
          agents?: unknown;
          activeStreams?: unknown;
          activeStreamCount?: unknown;
        };
        const agents = Array.isArray(json.agents) ? (json.agents as Record<string, unknown>[]) : [];
        const activeStreams = Array.isArray(json.activeStreams) ? json.activeStreams.length : 0;
        const count =
          typeof json.activeStreamCount === "number"
            ? json.activeStreamCount
            : activeStreams;
        return ok({ online: true, agents, activeStreams: count });
      }
    } catch {
      // direct registry fetch failed → fall back to the lib probes
    }
    const [agents, online] = await Promise.all([getHubAgents(), getHubOnline()]);
    return ok({ online, agents: agents ?? [], activeStreams: 0 });
  } catch (e) {
    console.error("GET /api/hub/status failed", e);
    return err("Failed to check hub status", 500);
  }
}
