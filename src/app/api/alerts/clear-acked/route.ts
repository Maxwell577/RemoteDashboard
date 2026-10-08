// POST /api/alerts/clear-acked → { deleted: number }
// Housekeeping: permanently removes acknowledged alerts (keeps the
// unacknowledged queue intact) and writes an audit entry.
import { db } from "@/lib/db";
import { err, ok, writeAudit } from "@/lib/api-helpers";

export const dynamic = "force-dynamic";

export async function POST() {
  try {
    const result = await db.alert.deleteMany({ where: { acknowledged: true } });
    await writeAudit({
      action: "alerts.clear_acked",
      detail: `Cleared ${result.count} acknowledged alert${result.count === 1 ? "" : "s"}`,
      severity: "info",
    });
    return ok({ deleted: result.count });
  } catch (e) {
    console.error("POST /api/alerts/clear-acked failed", e);
    return err("Failed to clear acknowledged alerts", 500);
  }
}
