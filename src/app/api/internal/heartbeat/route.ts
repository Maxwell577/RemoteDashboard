// POST /api/internal/heartbeat  (hub → api, x-hub-token)
// body: { agentId, metrics?, status?, location? { lat, lon, label? } } → { ok }
import type { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { asStringOrNull, err, ok, readBody, verifyHubToken } from "@/lib/api-helpers";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    if (!verifyHubToken(req)) return err("Unauthorized", 401);
    const body = await readBody<{
      agentId?: string;
      metrics?: unknown;
      status?: string;
      location?: { lat?: unknown; lon?: unknown; label?: unknown };
    }>(req);
    if (!body?.agentId) return err("agentId is required", 400);

    const data: {
      status: string;
      lastSeen: Date;
      locationLat?: number;
      locationLon?: number;
      locationLabel?: string;
    } = {
      status: body.status === "offline" ? "offline" : "online",
      lastSeen: new Date(),
    };
    const loc = body.location;
    if (
      loc &&
      typeof loc === "object" &&
      typeof loc.lat === "number" &&
      typeof loc.lon === "number"
    ) {
      data.locationLat = loc.lat;
      data.locationLon = loc.lon;
      const label = asStringOrNull(loc.label);
      if (label) data.locationLabel = label;
    }

    await db.device.updateMany({ where: { agentId: body.agentId }, data });
    return ok({ ok: true });
  } catch (e) {
    console.error("POST /api/internal/heartbeat failed", e);
    return err("Heartbeat processing failed", 500);
  }
}
