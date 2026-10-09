// GET /api/devices → Device[] (online-first, then hostname).
// Effective status is COMPUTED (status==='online' && lastSeen < 45s), never written.
import type { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { err, isEffectivelyOnline, ok } from "@/lib/api-helpers";
import { toDevice } from "@/lib/serialize";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest) {
  try {
    const rows = await db.device.findMany();
    const now = Date.now();
    const devices = rows.map(toDevice).sort((a, b) => {
      const aOnline = isEffectivelyOnline(a.status, a.lastSeen, now);
      const bOnline = isEffectivelyOnline(b.status, b.lastSeen, now);
      if (aOnline !== bOnline) return aOnline ? -1 : 1;
      return a.hostname.localeCompare(b.hostname);
    });
    return ok(devices);
  } catch (e) {
    console.error("GET /api/devices failed", e);
    return err("Failed to list devices", 500);
  }
}
