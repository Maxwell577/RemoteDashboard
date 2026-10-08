// POST /api/internal/media/result  (hub → api, x-hub-token)
// body: { assetId, status, dataRef?, sizeBytes?, error? } → { ok }
import type { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { asIntOrNull, err, isNotFound, ok, readBody, verifyHubToken } from "@/lib/api-helpers";

export const dynamic = "force-dynamic";

const MEDIA_STATUSES = [
  "requested",
  "capturing",
  "processing",
  "available",
  "failed",
  "stopped",
] as const;
const TERMINAL = new Set(["available", "failed", "stopped"]);

export async function POST(req: NextRequest) {
  try {
    if (!verifyHubToken(req)) return err("Unauthorized", 401);
    const body = await readBody<{
      assetId?: string;
      status?: string;
      dataRef?: string;
      sizeBytes?: number;
      error?: string;
    }>(req);
    if (!body?.assetId) return err("assetId is required", 400);
    if (!body.status || !(MEDIA_STATUSES as readonly string[]).includes(body.status)) {
      return err(`status must be one of: ${MEDIA_STATUSES.join(", ")}`, 400);
    }

    await db.mediaAsset.update({
      where: { id: body.assetId },
      data: {
        status: body.status,
        ...(typeof body.dataRef === "string" ? { dataRef: body.dataRef } : {}),
        ...(asIntOrNull(body.sizeBytes) !== null ? { sizeBytes: asIntOrNull(body.sizeBytes) } : {}),
        ...(typeof body.error === "string" ? { error: body.error } : {}),
        ...(TERMINAL.has(body.status) ? { completedAt: new Date() } : {}),
      },
    });
    return ok({ ok: true });
  } catch (e) {
    if (isNotFound(e)) return err("Media asset not found", 404);
    console.error("POST /api/internal/media/result failed", e);
    return err("Media result processing failed", 500);
  }
}
