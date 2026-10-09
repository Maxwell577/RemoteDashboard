// GET /api/files/operations?deviceId=&limit= → FileOperation[]
import type { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { err, intParam, ok } from "@/lib/api-helpers";
import { toFileOp } from "@/lib/serialize";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams;
    const deviceId = sp.get("deviceId");
    const limit = intParam(sp, "limit", 50);
    const rows = await db.fileOperation.findMany({
      where: deviceId ? { deviceId } : undefined,
      orderBy: { createdAt: "desc" },
      take: limit,
    });
    return ok(rows.map(toFileOp));
  } catch (e) {
    console.error("GET /api/files/operations failed", e);
    return err("Failed to list file operations", 500);
  }
}
