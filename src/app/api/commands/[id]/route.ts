// GET /api/commands/[id] → CommandExecution (used for result polling)
import type { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { err, ok } from "@/lib/api-helpers";
import { toCommand } from "@/lib/serialize";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const row = await db.commandExecution.findUnique({ where: { id } });
    if (!row) return err("Command not found", 404);
    return ok(toCommand(row));
  } catch (e) {
    console.error("GET /api/commands/[id] failed", e);
    return err("Failed to load command", 500);
  }
}
