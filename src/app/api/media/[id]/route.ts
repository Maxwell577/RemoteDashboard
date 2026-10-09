// DELETE /api/media/[id] → { ok }
import type { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { err, isNotFound, ok } from "@/lib/api-helpers";

export const dynamic = "force-dynamic";

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    await db.mediaAsset.delete({ where: { id } });
    return ok({ ok: true });
  } catch (e) {
    if (isNotFound(e)) return err("Media asset not found", 404);
    console.error("DELETE /api/media/[id] failed", e);
    return err("Failed to delete media asset", 500);
  }
}
