// POST /api/alert-rules/evaluate
// Admin-triggered evaluation ("Evaluate now" in Settings). Body:
//   { entries: [{ deviceId, hostname, cpu, memory, disk }] }
// Runs the same engine as the heartbeat path over the supplied snapshots
// (usually the live metrics currently on screen) and reports what fired.
import type { NextRequest } from "next/server";
import { err, getAppSettings, ok, readBody, writeAudit } from "@/lib/api-helpers";
import { evaluateRulesForDevice, type RuleEvaluationInput } from "@/lib/alert-rules";
import { getAlertRules } from "@/lib/alert-rules";
import type { Alert } from "@/lib/types";

export const dynamic = "force-dynamic";

interface EvaluateEntry {
  deviceId?: unknown;
  hostname?: unknown;
  cpu?: unknown;
  memory?: unknown;
  disk?: unknown;
  tags?: unknown;
}

function numOrNull(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

export async function POST(req: NextRequest) {
  try {
    const body = await readBody<{ entries?: EvaluateEntry[] }>(req);
    const entries = body?.entries;
    if (!Array.isArray(entries)) return err("entries array is required", 400);
    if (entries.length > 100) return err("Too many entries (max 100)", 400);

    const [rules, settings] = await Promise.all([getAlertRules(), getAppSettings()]);
    const fired: Alert[] = [];
    const results: { deviceId: string; hostname: string; fired: number }[] = [];

    for (const raw of entries) {
      const deviceId = typeof raw?.deviceId === "string" ? raw.deviceId : "";
      const hostname = typeof raw?.hostname === "string" ? raw.hostname : deviceId;
      if (!deviceId) continue;
      const entry: RuleEvaluationInput = {
        deviceId,
        hostname,
        cpuPercent: numOrNull(raw?.cpu),
        memoryPercent: numOrNull(raw?.memory),
        diskPercent: numOrNull(raw?.disk),
        tags: Array.isArray(raw?.tags)
          ? (raw.tags as unknown[]).filter((t): t is string => typeof t === "string")
          : [],
      };
      const created = await evaluateRulesForDevice(entry, rules, settings.alertRulesEnabled);
      fired.push(...created);
      results.push({ deviceId, hostname, fired: created.length });
    }

    if (fired.length > 0) {
      await writeAudit({
        action: "alerts.rules_evaluate",
        detail: `manual evaluation fired ${fired.length} alert(s) across ${results.length} device(s)`,
        severity: "info",
      });
    }
    return ok({ fired, results, engineEnabled: settings.alertRulesEnabled });
  } catch (e) {
    console.error("POST /api/alert-rules/evaluate failed", e);
    return err("Evaluation failed", 500);
  }
}
