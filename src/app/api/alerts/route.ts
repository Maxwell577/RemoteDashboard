// GET /api/alerts?unackOnly=1&limit= → Alert[]
import type { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { err, intParam, ok } from "@/lib/api-helpers";
import { toAlert } from "@/lib/serialize";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams;
    const unackOnly = ["1", "true"].includes(sp.get("unackOnly") ?? "");
    const limit = intParam(sp, "limit", 100);
    const rows = await db.alert.findMany({
      where: unackOnly ? { acknowledged: false } : undefined,
      orderBy: { createdAt: "desc" },
      take: limit,
    });
    return ok(rows.map(toAlert));
  } catch (e) {
    console.error("GET /api/alerts failed", e);
    return err("Failed to list alerts", 500);
  }
}
