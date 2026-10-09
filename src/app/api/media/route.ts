// GET  /api/media?deviceId=&limit= → MediaAsset[]
// POST /api/media  body: { deviceId, kind, quality?, durationSec?, withMic? } → MediaAsset
// (Contract alias /api/media/record shares the same POST handler.)
import type { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { err, handleMediaRecord, intParam, ok } from "@/lib/api-helpers";
import { toMedia } from "@/lib/serialize";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams;
    const deviceId = sp.get("deviceId");
    const limit = intParam(sp, "limit", 50);
    const rows = await db.mediaAsset.findMany({
      where: deviceId ? { deviceId } : undefined,
      orderBy: { createdAt: "desc" },
      take: limit,
    });
    return ok(rows.map(toMedia));
  } catch (e) {
    console.error("GET /api/media failed", e);
    return err("Failed to list media assets", 500);
  }
}

export async function POST(req: NextRequest) {
  return handleMediaRecord(req);
}
