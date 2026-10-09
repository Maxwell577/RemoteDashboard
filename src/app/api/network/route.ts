// GET  /api/network?deviceId= → NetworkCapture[]
// POST /api/network  body: { deviceId, iface?, filterBpf? } → NetworkCapture (running)
// (Contract alias /api/network/start shares the same POST handler.)
import type { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { err, handleNetworkStart, intParam, ok } from "@/lib/api-helpers";
import { toCapture } from "@/lib/serialize";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams;
    const deviceId = sp.get("deviceId");
    const limit = intParam(sp, "limit", 100);
    const rows = await db.networkCapture.findMany({
      where: deviceId ? { deviceId } : undefined,
      orderBy: { startedAt: "desc" },
      take: limit,
    });
    return ok(rows.map(toCapture));
  } catch (e) {
    console.error("GET /api/network failed", e);
    return err("Failed to list captures", 500);
  }
}

export async function POST(req: NextRequest) {
  return handleNetworkStart(req);
}
