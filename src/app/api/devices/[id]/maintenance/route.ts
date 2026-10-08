// POST /api/devices/[id]/maintenance  body: { maintenance: boolean } → Device
// Toggles the per-device maintenance window. While maintenance is on, the
// internal alerts route suppresses new alerts for this device (offline /
// disconnect noise during planned work), and the UI shows a wrench badge.
import type { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { err, ok, readBody, resolveDevice, writeAudit } from "@/lib/api-helpers";
import { toDevice } from "@/lib/serialize";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await readBody<{ maintenance?: unknown }>(req);
    if (!body || typeof body.maintenance !== "boolean") {
      return err("maintenance (boolean) is required", 400);
    }
    const device = await resolveDevice(id);
    if (!device) return err("Device not found", 404);
    const updated = await db.device.update({
      where: { id: device.id },
      data: { maintenance: body.maintenance },
    });
    await writeAudit({
      deviceId: device.id,
      action: body.maintenance ? "device.maintenance.on" : "device.maintenance.off",
      detail: body.maintenance
        ? "Maintenance window opened — alerts suppressed"
        : "Maintenance window closed — alerts active",
      severity: "info",
    });
    return ok(toDevice(updated));
  } catch (e) {
    console.error("POST /api/devices/[id]/maintenance failed", e);
    return err("Failed to update maintenance mode", 500);
  }
}
