// GET /api/audit?deviceId=&limit= → AuditLog[]
import type { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { err, intParam, ok } from "@/lib/api-helpers";
import { toAudit } from "@/lib/serialize";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams;
    const deviceId = sp.get("deviceId");
    const limit = intParam(sp, "limit", 200);
    const rows = await db.auditLog.findMany({
      where: deviceId ? { deviceId } : undefined,
      orderBy: { createdAt: "desc" },
      take: limit,
    });
    return ok(rows.map(toAudit));
  } catch (e) {
    console.error("GET /api/audit failed", e);
    return err("Failed to list audit events", 500);
  }
}
