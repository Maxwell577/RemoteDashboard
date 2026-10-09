// POST /api/internal/network/stats  (hub → api, x-hub-token)
// body: { captureId, packets, bytesCaptured } → { ok }
import type { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { asIntOr, err, isNotFound, ok, readBody, verifyHubToken } from "@/lib/api-helpers";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    if (!verifyHubToken(req)) return err("Unauthorized", 401);
    const body = await readBody<{ captureId?: string; packets?: number; bytesCaptured?: number }>(req);
    if (!body?.captureId) return err("captureId is required", 400);

    await db.networkCapture.update({
      where: { id: body.captureId },
      data: {
        packets: asIntOr(body.packets, 0),
        bytesCaptured: asIntOr(body.bytesCaptured, 0),
      },
    });
    return ok({ ok: true });
  } catch (e) {
    if (isNotFound(e)) return err("Capture not found", 404);
    console.error("POST /api/internal/network/stats failed", e);
    return err("Network stats processing failed", 500);
  }
}
