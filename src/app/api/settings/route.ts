// GET /api/settings → AppSettings
// PUT /api/settings  body: Partial<AppSettings> → AppSettings
import type { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { err, getAppSettings, ok, readBody } from "@/lib/api-helpers";
import type { AppSettings } from "@/lib/types";

export const dynamic = "force-dynamic";

const STREAM_QUALITIES = ["480p", "720p", "1080p"] as const;

/** Merge a partial patch over current settings, coercing + validating fields. */
function mergeSettings(current: AppSettings, patch: Record<string, unknown>): AppSettings {
  const next: AppSettings = { ...current };
  if (typeof patch.capturePassword === "string") next.capturePassword = patch.capturePassword;
  if (typeof patch.retentionDays === "number" && Number.isFinite(patch.retentionDays) && patch.retentionDays > 0) {
    next.retentionDays = Math.round(patch.retentionDays);
  }
  if (
    typeof patch.defaultStreamQuality === "string" &&
    (STREAM_QUALITIES as readonly string[]).includes(patch.defaultStreamQuality)
  ) {
    next.defaultStreamQuality = patch.defaultStreamQuality as AppSettings["defaultStreamQuality"];
  }
  if (
    typeof patch.heartbeatIntervalSec === "number" &&
    Number.isFinite(patch.heartbeatIntervalSec) &&
    patch.heartbeatIntervalSec > 0
  ) {
    next.heartbeatIntervalSec = Math.round(patch.heartbeatIntervalSec);
  }
  if (typeof patch.alertsOnOffline === "boolean") next.alertsOnOffline = patch.alertsOnOffline;
  if (typeof patch.alertsOnNewDevice === "boolean") next.alertsOnNewDevice = patch.alertsOnNewDevice;
  if (typeof patch.alertRulesEnabled === "boolean") next.alertRulesEnabled = patch.alertRulesEnabled;
  if (typeof patch.inMemoryModeDefault === "boolean") next.inMemoryModeDefault = patch.inMemoryModeDefault;
  if (typeof patch.supabaseUrl === "string") next.supabaseUrl = patch.supabaseUrl;
  if (typeof patch.supabaseBucket === "string") next.supabaseBucket = patch.supabaseBucket;
  if (typeof patch.hubUrl === "string" && patch.hubUrl.trim() !== "") next.hubUrl = patch.hubUrl.trim();
  return next;
}

export async function GET() {
  try {
    return ok(await getAppSettings());
  } catch (e) {
    console.error("GET /api/settings failed", e);
    return err("Failed to load settings", 500);
  }
}

export async function PUT(req: NextRequest) {
  try {
    const body = await readBody<Record<string, unknown>>(req);
    if (!body || typeof body !== "object") return err("Invalid JSON body", 400);
    const current = await getAppSettings();
    const merged = mergeSettings(current, body);
    await db.setting.upsert({
      where: { key: "app" },
      create: { key: "app", value: JSON.stringify(merged) },
      update: { value: JSON.stringify(merged) },
    });
    return ok(merged);
  } catch (e) {
    console.error("PUT /api/settings failed", e);
    return err("Failed to save settings", 500);
  }
}
