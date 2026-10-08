// SentraRMM — Alert rules engine (server-side).
//
// Threshold rules live in the Setting table under key "alertRules" as a JSON
// array of AlertRule. Every device heartbeat that carries metrics is evaluated
// against the enabled rules; a breach creates an Alert row unless:
//   - the engine is disabled (AppSettings.alertRulesEnabled),
//   - the device is in a maintenance window (alerts suppressed),
//   - the same rule already fired for this device within `cooldownMin`.
//
// Cooldown is derived from the Alert table itself (stateless — survives
// restarts and works identically for the admin "evaluate now" endpoint).
import { db } from "@/lib/db";
import { getAppSettings } from "@/lib/api-helpers";
import {
  DEFAULT_ALERT_RULES,
  METRIC_LABELS,
  type Alert,
  type AlertRule,
} from "@/lib/types";
import { toAlert } from "@/lib/serialize";

const RULES_KEY = "alertRules";

/** Load rules from the Setting blob; seed the defaults on first use. */
export async function getAlertRules(): Promise<AlertRule[]> {
  const row = await db.setting.findUnique({ where: { key: RULES_KEY } });
  if (!row) return [...DEFAULT_ALERT_RULES];
  try {
    const parsed = JSON.parse(row.value) as AlertRule[];
    return Array.isArray(parsed) ? parsed : [...DEFAULT_ALERT_RULES];
  } catch {
    return [...DEFAULT_ALERT_RULES];
  }
}

/** Replace the whole rules array (already validated by the route). */
export async function saveAlertRules(rules: AlertRule[]): Promise<void> {
  await db.setting.upsert({
    where: { key: RULES_KEY },
    create: { key: RULES_KEY, value: JSON.stringify(rules) },
    update: { value: JSON.stringify(rules) },
  });
}

export interface RuleEvaluationInput {
  deviceId: string;
  hostname: string;
  cpuPercent?: number | null;
  memoryPercent?: number | null;
  diskPercent?: number | null;
}

/** The metric value a rule tests, from the telemetry snapshot. */
function metricValue(rule: AlertRule, entry: RuleEvaluationInput): number | null {
  switch (rule.metric) {
    case "cpu":
      return entry.cpuPercent ?? null;
    case "memory":
      return entry.memoryPercent ?? null;
    case "disk":
      return entry.diskPercent ?? null;
  }
}

/** Stable alert title per rule+device — also the cooldown lookup key. */
export function ruleAlertTitle(rule: AlertRule, hostname: string): string {
  return `${rule.name} — ${hostname}`;
}

export function ruleAlertMessage(
  rule: AlertRule,
  entry: RuleEvaluationInput,
  value: number,
): string {
  const cond = rule.op === "gt" ? "above" : "below";
  return `${METRIC_LABELS[rule.metric]} usage is ${value.toFixed(1)}% on ${entry.hostname} — ${cond} the ${rule.threshold}% threshold. Re-alerts in ${rule.cooldownMin} min while the condition persists.`;
}

function isBreached(rule: AlertRule, value: number): boolean {
  return rule.op === "gt" ? value > rule.threshold : value < rule.threshold;
}

/**
 * Evaluate one device telemetry snapshot against the given rules.
 * Returns the Alert rows it created (already cooldown/maintenance-checked).
 * Never throws — evaluation failures must not break a heartbeat.
 */
export async function evaluateRulesForDevice(
  entry: RuleEvaluationInput,
  rules: AlertRule[],
  engineEnabled: boolean,
): Promise<Alert[]> {
  if (!engineEnabled || rules.length === 0) return [];
  const fired: Alert[] = [];
  for (const rule of rules) {
    try {
      if (!rule.enabled) continue;
      const value = metricValue(rule, entry);
      if (value == null || !Number.isFinite(value)) continue;
      if (!isBreached(rule, value)) continue;

      const since = new Date(Date.now() - rule.cooldownMin * 60_000);
      const recent = await db.alert.findFirst({
        where: {
          deviceId: entry.deviceId,
          title: ruleAlertTitle(rule, entry.hostname),
          createdAt: { gt: since },
        },
        select: { id: true },
      });
      if (recent) continue; // still cooling down

      const maintenance = await db.device.findUnique({
        where: { id: entry.deviceId },
        select: { maintenance: true },
      });
      if (maintenance?.maintenance) continue;

      const alert = await db.alert.create({
        data: {
          deviceId: entry.deviceId,
          title: ruleAlertTitle(rule, entry.hostname),
          message: ruleAlertMessage(rule, entry, value),
          severity: rule.severity,
        },
      });
      fired.push(toAlert(alert));
    } catch (e) {
      console.error(`alert-rule "${rule.name}" evaluation failed for ${entry.hostname}`, e);
    }
  }
  return fired;
}
