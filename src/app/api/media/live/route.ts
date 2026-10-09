// POST /api/media/live  body: { deviceId, action: "start" | "stop" }
// Starts/stops the live screen viewer stream on an agent. Frames are NOT
// persisted — they stream one-way over the socket as `screen:frame` events
// until stopped (in-memory only, matching SentraRMM's capture philosophy).
import type { NextRequest } from "next/server";
import { err, ok, readBody, resolveDevice, writeAudit } from "@/lib/api-helpers";
import { dispatchToHub } from "@/lib/hub";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const body = await readBody<{ deviceId?: string; action?: string }>(req);
    if (!body?.deviceId) return err("deviceId is required", 400);
    const action = body.action === "stop" ? "stop" : "start";
    const device = await resolveDevice(body.deviceId);
    if (!device) return err("Device not found", 404);

    const res =
      action === "start"
        ? await dispatchToHub<{ started?: unknown; fps?: unknown }>(
            device.agentId,
            "screen:live:start",
            { fps: 2 },
            { deviceId: device.id },
          )
        : await dispatchToHub<{ frames?: unknown }>(
            device.agentId,
            "screen:live:stop",
            {},
            { deviceId: device.id },
          );

    if (!res.ok) {
      await writeAudit({
        deviceId: device.id,
        action: "media.live",
        detail: `${action} failed: ${res.error}`,
        severity: "warning",
      });
      return err(res.error, 502);
    }

    await writeAudit({
      deviceId: device.id,
      action: "media.live",
      detail: action === "start" ? "live screen viewer started (stream-only, not persisted)" : "live screen viewer stopped",
      severity: "info",
    });

    return ok({ ok: true, agentId: device.agentId, action });
  } catch (e) {
    console.error("POST /api/media/live failed", e);
    return err("Live view request failed", 500);
  }
}
