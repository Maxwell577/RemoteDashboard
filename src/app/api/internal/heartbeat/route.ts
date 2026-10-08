// POST /api/internal/heartbeat  (hub → api, x-hub-token)
// body: { agentId, metrics?, status?, location? { lat, lon, label? } }
// → { ok: true, fired: Alert[] }
//
// `fired` carries any alerts raised by the threshold rules engine for this
// heartbeat's telemetry; the hub relays each one to the dashboard room as
// `alert:new` so rule alerts toast + sound in realtime.
import type { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { asStringOrNull, err, getAppSettings, ok, readBody, verifyHubToken } from "@/lib/api-helpers";
import { evaluateRulesForDevice } from "@/lib/alert-rules";
import { getAlertRules } from "@/lib/alert-rules";
import type { Alert } from "@/lib/types";

export const dynamic = "force-dynamic";

function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export async function POST(req: NextRequest) {
  try {
    if (!verifyHubToken(req)) return err("Unauthorized", 401);
    const body = await readBody<{
      agentId?: string;
      metrics?: unknown;
      status?: string;
      location?: { lat?: unknown; lon?: unknown; label?: unknown };
    }>(req);
    if (!body?.agentId) return err("agentId is required", 400);

    const data: {
      status: string;
      lastSeen: Date;
      locationLat?: number;
      locationLon?: number;
      locationLabel?: string;
    } = {
      status: body.status === "offline" ? "offline" : "online",
      lastSeen: new Date(),
    };
    const loc = body.location;
    if (
      loc &&
      typeof loc === "object" &&
      typeof loc.lat === "number" &&
      typeof loc.lon === "number"
    ) {
      data.locationLat = loc.lat;
      data.locationLon = loc.lon;
      const label = asStringOrNull(loc.label);
      if (label) data.locationLabel = label;
    }

    const res = await db.device.updateMany({ where: { agentId: body.agentId }, data });

    // Threshold rules engine — only for online heartbeats that carry metrics.
    const fired: Alert[] = [];
    const m = body.metrics;
    if (res.count > 0 && body.status !== "offline" && m && typeof m === "object") {
      try {
        const device = await db.device.findUnique({
          where: { agentId: body.agentId },
          select: { id: true, hostname: true },
        });
        if (device) {
          const [rules, settings] = await Promise.all([getAlertRules(), getAppSettings()]);
          const created = await evaluateRulesForDevice(
            {
              deviceId: device.id,
              hostname: device.hostname,
              cpuPercent: numOrNull((m as Record<string, unknown>).cpuPercent),
              memoryPercent: numOrNull((m as Record<string, unknown>).memoryPercent),
              diskPercent: numOrNull((m as Record<string, unknown>).diskPercent),
            },
            rules,
            settings.alertRulesEnabled,
          );
          fired.push(...created);
        }
      } catch (e) {
        // rule engine must never break the heartbeat
        console.error("heartbeat rule evaluation failed (ignored)", e);
      }
    }

    return ok({ ok: true, fired });
  } catch (e) {
    console.error("POST /api/internal/heartbeat failed", e);
    return err("Heartbeat processing failed", 500);
  }
}
