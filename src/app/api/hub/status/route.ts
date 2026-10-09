// GET /api/hub/status → { online: boolean, agents: HubAgent[] }
import type { NextRequest } from "next/server";
import { err, ok } from "@/lib/api-helpers";
import { getHubAgents, getHubOnline } from "@/lib/hub";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest) {
  try {
    const [agents, online] = await Promise.all([getHubAgents(), getHubOnline()]);
    return ok({ online, agents: agents ?? [] });
  } catch (e) {
    console.error("GET /api/hub/status failed", e);
    return err("Failed to check hub status", 500);
  }
}
