// POST /api/internal/location  (hub → api, x-hub-token)
// body: { agentId, lat, lon, accuracyM?, label?, source } → { ok }
import type { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { asIntOrNull, asStringOrNull, err, ok, readBody, verifyHubToken } from "@/lib/api-helpers";

export const dynamic = "force-dynamic";

const PING_SOURCES = ["ip", "gps", "wifi"] as const;

export async function POST(req: NextRequest) {
  try {
    if (!verifyHubToken(req)) return err("Unauthorized", 401);
    const body = await readBody<{
      agentId?: string;
      lat?: number;
      lon?: number;
      accuracyM?: number;
      label?: string;
      source?: string;
    }>(req);
    if (!body?.agentId) return err("agentId is required", 400);
    if (typeof body.lat !== "number" || typeof body.lon !== "number") {
      return err("lat and lon (numbers) are required", 400);
    }
    const device = await db.device.findUnique({ where: { agentId: body.agentId } });
    if (!device) return err("Device not found", 404);

    const label = asStringOrNull(body.label);
    const source = (PING_SOURCES as readonly string[]).includes(body.source ?? "")
      ? (body.source as (typeof PING_SOURCES)[number])
      : "ip";

    await db.locationPing.create({
      data: {
        deviceId: device.id,
        lat: body.lat,
        lon: body.lon,
        accuracyM: asIntOrNull(body.accuracyM),
        label,
        source,
      },
    });
    await db.device.update({
      where: { id: device.id },
      data: { locationLat: body.lat, locationLon: body.lon, locationLabel: label },
    });
    return ok({ ok: true });
  } catch (e) {
    console.error("POST /api/internal/location failed", e);
    return err("Location processing failed", 500);
  }
}
