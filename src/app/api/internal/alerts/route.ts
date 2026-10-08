// POST /api/internal/alerts  (hub → api, x-hub-token)
// body: { deviceId?, agentIdHint?, title, message, severity } → Alert
import type { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { coerceSeverity, err, ok, readBody, verifyHubToken } from "@/lib/api-helpers";
import { toAlert } from "@/lib/serialize";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    if (!verifyHubToken(req)) return err("Unauthorized", 401);
    const body = await readBody<{
      deviceId?: string;
      agentIdHint?: string;
      title?: string;
      message?: string;
      severity?: string;
    }>(req);
    if (!body?.title?.trim() || !body.message?.trim()) {
      return err("title and message are required", 400);
    }
    if (body.severity !== undefined && body.severity !== null && !["info", "warning", "critical"].includes(body.severity)) {
      return err("severity must be info, warning or critical", 400);
    }

    let deviceId = typeof body.deviceId === "string" && body.deviceId ? body.deviceId : null;
    if (!deviceId && body.agentIdHint) {
      const device = await db.device.findUnique({ where: { agentId: body.agentIdHint } });
      deviceId = device?.id ?? null;
    }

    const alert = await db.alert.create({
      data: {
        deviceId,
        title: body.title.trim(),
        message: body.message.trim(),
        severity: coerceSeverity(body.severity),
      },
    });
    return ok(toAlert(alert));
  } catch (e) {
    console.error("POST /api/internal/alerts failed", e);
    return err("Alert creation failed", 500);
  }
}
