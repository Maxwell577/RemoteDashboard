// POST /api/network/stop  body: { deviceId } → NetworkCapture (stopped)
import type { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { asIntOr, err, ok, readBody, resolveDevice, writeAudit } from "@/lib/api-helpers";
import { dispatchToHub } from "@/lib/hub";
import { toCapture } from "@/lib/serialize";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const body = await readBody<{ deviceId?: string }>(req);
    if (!body?.deviceId) return err("deviceId is required", 400);
    const device = await resolveDevice(body.deviceId);
    if (!device) return err("Device not found", 404);

    const capture = await db.networkCapture.findFirst({
      where: { deviceId: device.id, status: "running" },
      orderBy: { startedAt: "desc" },
    });
    if (!capture) return err("No running capture for this device", 404);

    const res = await dispatchToHub<{ packets?: unknown; bytesCaptured?: unknown }>(
      device.agentId,
      "net:stop",
      { captureId: capture.id },
      { captureId: capture.id, deviceId: device.id },
    );

    if (res.ok) {
      const updated = await db.networkCapture.update({
        where: { id: capture.id },
        data: {
          status: "stopped",
          stoppedAt: new Date(),
          packets: asIntOr(res.data?.packets, capture.packets),
          bytesCaptured: asIntOr(res.data?.bytesCaptured, capture.bytesCaptured),
        },
      });
      await writeAudit({
        deviceId: device.id,
        action: "network.capture.stop",
        detail: `${capture.iface} · ${updated.packets} packets / ${updated.bytesCaptured} bytes`,
        severity: "info",
      });
      return ok(toCapture(updated));
    }

    // Could not reach the agent — close the capture out as failed so the UI
    // is never left showing a phantom "running" state.
    await db.networkCapture.update({
      where: { id: capture.id },
      data: { status: "failed", stoppedAt: new Date() },
    });
    await writeAudit({
      deviceId: device.id,
      action: "network.capture.stop",
      detail: `failed: ${res.error}`,
      severity: "warning",
    });
    return err(res.error, 502);
  } catch (e) {
    console.error("POST /api/network/stop failed", e);
    return err("Failed to stop capture", 500);
  }
}
