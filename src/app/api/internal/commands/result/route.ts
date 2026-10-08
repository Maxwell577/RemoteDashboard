// POST /api/internal/commands/result  (hub → api, x-hub-token)
// body: { commandId, status, output?, exitCode?, durationMs? } → { ok }
import type { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { asIntOrNull, err, isNotFound, ok, readBody, verifyHubToken } from "@/lib/api-helpers";

export const dynamic = "force-dynamic";

const COMMAND_STATUSES = ["pending", "running", "completed", "failed", "timeout"] as const;

export async function POST(req: NextRequest) {
  try {
    if (!verifyHubToken(req)) return err("Unauthorized", 401);
    const body = await readBody<{
      commandId?: string;
      status?: string;
      output?: string;
      exitCode?: number;
      durationMs?: number;
    }>(req);
    if (!body?.commandId) return err("commandId is required", 400);
    if (!body.status || !(COMMAND_STATUSES as readonly string[]).includes(body.status)) {
      return err(`status must be one of: ${COMMAND_STATUSES.join(", ")}`, 400);
    }
    const terminal = body.status !== "pending" && body.status !== "running";

    await db.commandExecution.update({
      where: { id: body.commandId },
      data: {
        status: body.status,
        ...(typeof body.output === "string" ? { output: body.output } : {}),
        ...(asIntOrNull(body.exitCode) !== null ? { exitCode: asIntOrNull(body.exitCode) } : {}),
        ...(asIntOrNull(body.durationMs) !== null ? { durationMs: asIntOrNull(body.durationMs) } : {}),
        ...(terminal ? { completedAt: new Date() } : {}),
      },
    });
    return ok({ ok: true });
  } catch (e) {
    if (isNotFound(e)) return err("Command not found", 404);
    console.error("POST /api/internal/commands/result failed", e);
    return err("Command result processing failed", 500);
  }
}
