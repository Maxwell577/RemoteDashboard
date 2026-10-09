// GET /api/metrics/history?deviceId=X            → { deviceId, points }  (one device)
// GET /api/metrics/history?minutes=30            → { minutes, series: { [deviceId]: TelemetryPoint[] } }  (all devices)
//
// Points are ascending by time. `minutes` defaults to 30, capped at 120
// (the persisted window is 2h). The server always returns raw samples;
// bucketing/averaging is a client concern.
import type { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { err, ok } from "@/lib/api-helpers";
import type { TelemetryPoint } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const minutes = Math.min(120, Math.max(1, Number(url.searchParams.get("minutes") ?? 30) || 30));
    const since = new Date(Date.now() - minutes * 60_000);
    const deviceId = url.searchParams.get("deviceId");

    if (deviceId) {
      const rows = await db.telemetrySample.findMany({
        where: { deviceId, createdAt: { gte: since } },
        orderBy: { createdAt: "asc" },
        select: { cpu: true, memory: true, disk: true, createdAt: true },
      });
      const points: TelemetryPoint[] = rows.map((r) => ({
        t: r.createdAt.getTime(),
        cpu: Math.round(r.cpu * 10) / 10,
        memory: Math.round(r.memory * 10) / 10,
        disk: Math.round(r.disk * 10) / 10,
      }));
      return ok({ deviceId, minutes, points });
    }

    // All devices — grouped by deviceId (DB ids, matching Device.id).
    const rows = await db.telemetrySample.findMany({
      where: { createdAt: { gte: since } },
      orderBy: { createdAt: "asc" },
      select: { deviceId: true, cpu: true, memory: true, disk: true, createdAt: true },
    });
    const series: Record<string, TelemetryPoint[]> = {};
    for (const r of rows) {
      (series[r.deviceId] ??= []).push({
        t: r.createdAt.getTime(),
        cpu: Math.round(r.cpu * 10) / 10,
        memory: Math.round(r.memory * 10) / 10,
        disk: Math.round(r.disk * 10) / 10,
      });
    }
    return ok({ minutes, series });
  } catch (e) {
    console.error("GET /api/metrics/history failed", e);
    return err("Failed to load telemetry history", 500);
  }
}
