// DELETE /api/saved-commands/[id] → { ok }
import type { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { err, isNotFound, ok } from "@/lib/api-helpers";

export const dynamic = "force-dynamic";

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    await db.savedCommand.delete({ where: { id } });
    return ok({ ok: true });
  } catch (e) {
    if (isNotFound(e)) return err("Saved command not found", 404);
    console.error("DELETE /api/saved-commands/[id] failed", e);
    return err("Failed to delete saved command", 500);
  }
}
