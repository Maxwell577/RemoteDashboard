// POST /api/location/ping  body: { deviceId } → LocationPing (fresh fix, sync)
import type { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { asIntOrNull, asStringOrNull, err, ok, readBody, resolveDevice, writeAudit } from "@/lib/api-helpers";
import { dispatchToHub } from "@/lib/hub";
import { toPing } from "@/lib/serialize";

export const dynamic = "force-dynamic";

const PING_SOURCES = ["ip", "gps", "wifi"] as const;

export async function POST(req: NextRequest) {
  try {
    const body = await readBody<{ deviceId?: string }>(req);
    if (!body?.deviceId) return err("deviceId is required", 400);
    const device = await resolveDevice(body.deviceId);
    if (!device) return err("Device not found", 404);

    const res = await dispatchToHub<Record<string, unknown>>(device.agentId, "location:fix", {}, {
      deviceId: device.id,
    });
    if (!res.ok) return err(res.error, 502);
    const fix = res.data ?? {};
    const lat = typeof fix.lat === "number" ? fix.lat : NaN;
    const lon = typeof fix.lon === "number" ? fix.lon : NaN;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return err("Agent returned invalid coordinates", 502);
    }
    const source = PING_SOURCES.includes(fix.source as (typeof PING_SOURCES)[number])
      ? (fix.source as (typeof PING_SOURCES)[number])
      : "ip";
    const label = asStringOrNull(fix.label);

    const ping = await db.locationPing.create({
      data: {
        deviceId: device.id,
        lat,
        lon,
        accuracyM: asIntOrNull(fix.accuracyM),
        label,
        source,
      },
    });
    await db.device.update({
      where: { id: device.id },
      data: { locationLat: lat, locationLon: lon, locationLabel: label },
    });
    await writeAudit({
      deviceId: device.id,
      action: "location.ping",
      detail: `${lat.toFixed(4)}, ${lon.toFixed(4)}${label ? ` · ${label}` : ""} (${source})`,
      severity: "info",
    });
    return ok(toPing(ping));
  } catch (e) {
    console.error("POST /api/location/ping failed", e);
    return err("Location ping failed", 500);
  }
}
