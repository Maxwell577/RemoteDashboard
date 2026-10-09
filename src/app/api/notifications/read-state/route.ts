// GET  /api/notifications/read-state → { lastReadAt: string | null }
// POST /api/notifications/read-state → mark "seen now" (syncs the
//       notification-center unread badge across browsers/sessions).
// The timestamp lives in the Setting table under key "notifyReadAt".
import type { NextRequest } from "next/server";
import { err, ok, writeAudit } from "@/lib/api-helpers";
import { db } from "@/lib/db";

export const dynamic = "force-dynamic";

const KEY = "notifyReadAt";

async function readLastMarked(): Promise<string | null> {
  const row = await db.setting.findUnique({ where: { key: KEY } });
  if (!row) return null;
  const iso = row.value;
  return Number.isFinite(Date.parse(iso)) ? iso : null;
}

export async function GET() {
  try {
    return ok({ lastReadAt: await readLastMarked() });
  } catch (e) {
    console.error("GET /api/notifications/read-state failed", e);
    return err("Failed to load notification read state", 500);
  }
}

export async function POST(_req: NextRequest) {
  try {
    const now = new Date().toISOString();
    await db.setting.upsert({
      where: { key: KEY },
      create: { key: KEY, value: now },
      update: { value: now },
    });
    await writeAudit({
      action: "notifications.read",
      detail: "notification center marked as read",
      severity: "info",
    });
    return ok({ lastReadAt: now });
  } catch (e) {
    console.error("POST /api/notifications/read-state failed", e);
    return err("Failed to mark notifications read", 500);
  }
}
