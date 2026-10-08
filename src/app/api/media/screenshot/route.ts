// POST /api/media/screenshot  body: { deviceId } → MediaAsset (sync capture)
import type { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { asIntOrNull, err, ok, readBody, resolveDevice, writeAudit } from "@/lib/api-helpers";
import { dispatchToHub } from "@/lib/hub";
import { toMedia } from "@/lib/serialize";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const body = await readBody<{ deviceId?: string }>(req);
    if (!body?.deviceId) return err("deviceId is required", 400);
    const device = await resolveDevice(body.deviceId);
    if (!device) return err("Device not found", 404);

    const asset = await db.mediaAsset.create({
      data: { deviceId: device.id, kind: "screenshot", status: "requested" },
    });

    const res = await dispatchToHub<{ dataUri?: unknown; sizeBytes?: unknown }>(
      device.agentId,
      "media:screenshot",
      {},
      { assetId: asset.id, deviceId: device.id },
    );

    let updated;
    if (res.ok && res.data && typeof res.data === "object" && typeof res.data.dataUri === "string") {
      updated = await db.mediaAsset.update({
        where: { id: asset.id },
        data: {
          status: "available",
          format: "png",
          dataRef: res.data.dataUri,
          sizeBytes: asIntOrNull(res.data.sizeBytes),
          completedAt: new Date(),
        },
      });
      await writeAudit({
        deviceId: device.id,
        action: "media.screenshot",
        detail: `captured (${updated.sizeBytes ?? "?"} bytes)`,
        severity: "info",
      });
    } else {
      const errorText = res.ok ? "Agent returned no screenshot data" : res.error;
      updated = await db.mediaAsset.update({
        where: { id: asset.id },
        data: { status: "failed", error: errorText, completedAt: new Date() },
      });
      await writeAudit({
        deviceId: device.id,
        action: "media.screenshot",
        detail: `failed: ${errorText}`,
        severity: "warning",
      });
    }
    return ok(toMedia(updated));
  } catch (e) {
    console.error("POST /api/media/screenshot failed", e);
    return err("Screenshot failed", 500);
  }
}
