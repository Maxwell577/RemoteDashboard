// POST /api/media/stop  body: { assetId } → MediaAsset (status stopped;
// final artifacts may still arrive later via /api/internal/media/result)
import type { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { err, ok, readBody } from "@/lib/api-helpers";
import { dispatchToHub } from "@/lib/hub";
import { toMedia } from "@/lib/serialize";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const body = await readBody<{ assetId?: string }>(req);
    if (!body?.assetId) return err("assetId is required", 400);
    const asset = await db.mediaAsset.findUnique({ where: { id: body.assetId } });
    if (!asset) return err("Media asset not found", 404);

    // Best-effort stop on the agent; the row is marked stopped regardless so
    // the dashboard reflects the operator's intent immediately.
    try {
      const device = await db.device.findUnique({ where: { id: asset.deviceId } });
      if (device) {
        await dispatchToHub(device.agentId, "media:stop", { assetId: asset.id }, {
          assetId: asset.id,
          deviceId: device.id,
        });
      }
    } catch {
      // non-fatal — hub may already be down
    }

    const updated = await db.mediaAsset.update({
      where: { id: asset.id },
      data: { status: "stopped" },
    });
    return ok(toMedia(updated));
  } catch (e) {
    console.error("POST /api/media/stop failed", e);
    return err("Failed to stop recording", 500);
  }
}
