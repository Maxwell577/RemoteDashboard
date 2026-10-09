// GET  /api/saved-commands → SavedCommand[]
// POST /api/saved-commands  body: { name, command, description?, category? } → SavedCommand
import type { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { err, ok, readBody } from "@/lib/api-helpers";
import { toSavedCommand } from "@/lib/serialize";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const rows = await db.savedCommand.findMany({ orderBy: { createdAt: "desc" } });
    return ok(rows.map(toSavedCommand));
  } catch (e) {
    console.error("GET /api/saved-commands failed", e);
    return err("Failed to list saved commands", 500);
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await readBody<{
      name?: string;
      command?: string;
      description?: string;
      category?: string;
    }>(req);
    if (!body?.name?.trim() || !body.command?.trim()) {
      return err("name and command are required", 400);
    }
    const row = await db.savedCommand.create({
      data: {
        name: body.name.trim(),
        command: body.command.trim(),
        description: body.description?.trim() || null,
        category: body.category?.trim() || "general",
      },
    });
    return ok(toSavedCommand(row));
  } catch (e) {
    console.error("POST /api/saved-commands failed", e);
    return err("Failed to save command", 500);
  }
}
