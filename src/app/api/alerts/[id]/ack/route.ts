// POST /api/alerts/[id]/ack → Alert (acknowledged)
import type { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { err, isNotFound, ok } from "@/lib/api-helpers";
import { toAlert } from "@/lib/serialize";

export const dynamic = "force-dynamic";

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const updated = await db.alert.update({
      where: { id },
      data: { acknowledged: true, ackedBy: "admin", acknowledgedAt: new Date() },
    });
    return ok(toAlert(updated));
  } catch (e) {
    if (isNotFound(e)) return err("Alert not found", 404);
    console.error("POST /api/alerts/[id]/ack failed", e);
    return err("Failed to acknowledge alert", 500);
  }
}
