// GET /api/location?deviceId= → { device, pings: LocationPing[] (desc, max 100) }
import type { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { err, ok, resolveDevice } from "@/lib/api-helpers";
import { toDevice, toPing } from "@/lib/serialize";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const deviceId = req.nextUrl.searchParams.get("deviceId");
    if (!deviceId) return err("deviceId is required", 400);
    const device = await resolveDevice(deviceId);
    if (!device) return err("Device not found", 404);
    const pings = await db.locationPing.findMany({
      where: { deviceId: device.id },
      orderBy: { createdAt: "desc" },
      take: 100,
    });
    return ok({ device: toDevice(device), pings: pings.map(toPing) });
  } catch (e) {
    console.error("GET /api/location failed", e);
    return err("Failed to load location history", 500);
  }
}
