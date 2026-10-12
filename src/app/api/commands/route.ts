// GET  /api/commands?deviceId=&limit= → CommandExecution[]
// POST /api/commands  body: { deviceId, command, shell? } → CommandExecution (final state)
//   shell: "powershell" (default) | "cmd" | "auto" — the agent reports the
//   effective shell it used, persisted on CommandExecution.effectiveShell.
import type { NextRequest } from "next/server";
import { db } from "@/lib/db";
import {
  err,
  intParam,
  ok,
  readBody,
  resolveDevice,
  writeAudit,
} from "@/lib/api-helpers";
import { dispatchToHub } from "@/lib/hub";
import { toCommand } from "@/lib/serialize";

export const dynamic = "force-dynamic";

const DANGEROUS_COMMAND = /(rm |del |format|Remove-Item|Stop-Process|shutdown)/i;
const SHELLS = ["powershell", "cmd", "auto"] as const;

export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams;
    const deviceId = sp.get("deviceId");
    const limit = intParam(sp, "limit", 50);
    const rows = await db.commandExecution.findMany({
      where: deviceId ? { deviceId } : undefined,
      orderBy: { createdAt: "desc" },
      take: limit,
    });
    return ok(rows.map(toCommand));
  } catch (e) {
    console.error("GET /api/commands failed", e);
    return err("Failed to list commands", 500);
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await readBody<{ deviceId?: string; command?: string; shell?: string }>(req);
    if (!body?.deviceId || !body.command || body.command.trim() === "") {
      return err("deviceId and command are required", 400);
    }
    if (body.shell !== undefined && !(SHELLS as readonly string[]).includes(body.shell)) {
      return err("shell must be one of: powershell, cmd, auto", 400);
    }
    const device = await resolveDevice(body.deviceId);
    if (!device) return err("Device not found", 404);
    const command = body.command;
    const shell = body.shell ?? "powershell";

    let row = await db.commandExecution.create({
      data: { deviceId: device.id, command, status: "pending", shell },
    });
    await writeAudit({
      deviceId: device.id,
      action: "command.exec",
      detail: command.slice(0, 500),
      severity: DANGEROUS_COMMAND.test(command) ? "warning" : "info",
    });

    // Dispatch to the agent via the hub. Never let a hub failure 500 the API —
    // the failure is recorded on the command row instead.
    let result: { ok: true; data: unknown } | { ok: false; error: string };
    try {
      result = await dispatchToHub(device.agentId, "exec", { command, shell }, {
        commandId: row.id,
        deviceId: device.id,
      });
    } catch {
      result = { ok: false, error: "Hub unreachable" };
    }

    if (result.ok) {
      const d = (result.data && typeof result.data === "object" ? result.data : {}) as {
        output?: unknown;
        exitCode?: unknown;
        durationMs?: unknown;
        shell?: unknown;
      };
      const num = (v: unknown): number | null =>
        typeof v === "number" && Number.isFinite(v) ? Math.round(v) : null;
      row = await db.commandExecution.update({
        where: { id: row.id },
        data: {
          status: "completed",
          output: typeof d.output === "string" ? d.output : "",
          exitCode: num(d.exitCode),
          durationMs: num(d.durationMs),
          effectiveShell: typeof d.shell === "string" && d.shell !== "" ? d.shell : null,
          completedAt: new Date(),
        },
      });
    } else {
      row = await db.commandExecution.update({
        where: { id: row.id },
        data: { status: "failed", output: result.error, completedAt: new Date() },
      });
    }
    return ok(toCommand(row));
  } catch (e) {
    console.error("POST /api/commands failed", e);
    return err("Failed to execute command", 500);
  }
}
