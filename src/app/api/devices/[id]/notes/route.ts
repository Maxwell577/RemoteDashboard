// POST /api/devices/[id]/notes  body: { notes } → Device
import type { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { err, ok, readBody, resolveDevice, writeAudit } from "@/lib/api-helpers";
import { toDevice } from "@/lib/serialize";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await readBody<{ notes?: string | null }>(req);
    if (!body || (body.notes !== null && typeof body.notes !== "string")) {
      return err("notes (string) is required", 400);
    }
    const device = await resolveDevice(id);
    if (!device) return err("Device not found", 404);
    const updated = await db.device.update({
      where: { id: device.id },
      data: { notes: body.notes },
    });
    await writeAudit({
      deviceId: device.id,
      action: "device.notes",
      detail: body.notes ? body.notes.slice(0, 300) : "(cleared)",
      severity: "info",
    });
    return ok(toDevice(updated));
  } catch (e) {
    console.error("POST /api/devices/[id]/notes failed", e);
    return err("Failed to save notes", 500);
  }
}
