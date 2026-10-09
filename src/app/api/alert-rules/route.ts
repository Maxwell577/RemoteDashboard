// GET /api/alert-rules → AlertRule[]
// PUT /api/alert-rules  body: AlertRule[] (full replace, validated) → AlertRule[]
// POST /api/alert-rules → restore the shipped default rules
import type { NextRequest } from "next/server";
import { err, ok, readBody, writeAudit } from "@/lib/api-helpers";
import { getAlertRules, saveAlertRules } from "@/lib/alert-rules";
import { DEFAULT_ALERT_RULES, type AlertRule } from "@/lib/types";

export const dynamic = "force-dynamic";

const METRICS = ["cpu", "memory", "disk"] as const;
const OPS = ["gt", "lt"] as const;
const SEVERITIES = ["info", "warning", "critical"] as const;

/** Coerce + validate one rule; returns null when invalid. */
function coerceRule(raw: unknown): AlertRule | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || r.id.trim() === "") return null;
  if (typeof r.name !== "string" || r.name.trim() === "" || r.name.length > 80) return null;
  if (!(METRICS as readonly string[]).includes(r.metric as string)) return null;
  if (!(OPS as readonly string[]).includes(r.op as string)) return null;
  const threshold = typeof r.threshold === "number" ? r.threshold : Number(r.threshold);
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 100) return null;
  if (!(SEVERITIES as readonly string[]).includes(r.severity as string)) return null;
  const cooldown = typeof r.cooldownMin === "number" ? r.cooldownMin : Number(r.cooldownMin);
  if (!Number.isFinite(cooldown) || cooldown < 1 || cooldown > 10080) return null;
  if (typeof r.enabled !== "boolean") return null;
  // optional tag scope — empty/missing becomes null (all devices)
  const deviceTag =
    typeof r.deviceTag === "string" && r.deviceTag.trim() !== ""
      ? r.deviceTag.trim().slice(0, 40)
      : null;
  return {
    id: r.id.trim(),
    name: r.name.trim(),
    metric: r.metric as AlertRule["metric"],
    op: r.op as AlertRule["op"],
    threshold: Math.round(threshold * 10) / 10,
    severity: r.severity as AlertRule["severity"],
    cooldownMin: Math.round(cooldown),
    enabled: r.enabled,
    deviceTag,
  };
}

export async function GET() {
  try {
    return ok(await getAlertRules());
  } catch (e) {
    console.error("GET /api/alert-rules failed", e);
    return err("Failed to load alert rules", 500);
  }
}

export async function PUT(req: NextRequest) {
  try {
    const body = await readBody<unknown>(req);
    const arr = Array.isArray(body) ? body : (body as { rules?: unknown[] } | null)?.rules;
    if (!Array.isArray(arr)) return err("Expected a rules array", 400);
    if (arr.length > 50) return err("Too many rules (max 50)", 400);

    const rules: AlertRule[] = [];
    const seen = new Set<string>();
    for (const raw of arr) {
      const rule = coerceRule(raw);
      if (!rule) return err("Invalid rule payload", 400);
      if (seen.has(rule.id)) return err(`Duplicate rule id: ${rule.id}`, 400);
      seen.add(rule.id);
      rules.push(rule);
    }

    await saveAlertRules(rules);
    await writeAudit({
      action: "alerts.rules_updated",
      detail: `${rules.filter((r) => r.enabled).length} of ${rules.length} rules enabled`,
      severity: "info",
    });
    return ok(rules);
  } catch (e) {
    console.error("PUT /api/alert-rules failed", e);
    return err("Failed to save alert rules", 500);
  }
}

/** Convenience: restore the shipped defaults (used by a Settings action). */
export async function POST() {
  try {
    await saveAlertRules([...DEFAULT_ALERT_RULES]);
    await writeAudit({ action: "alerts.rules_reset", detail: "restored default rules" });
    return ok([...DEFAULT_ALERT_RULES]);
  } catch (e) {
    console.error("POST /api/alert-rules failed", e);
    return err("Failed to reset alert rules", 500);
  }
}
