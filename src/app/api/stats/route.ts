// GET /api/stats → DashboardStats
import type { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { err, isEffectivelyOnline, ok } from "@/lib/api-helpers";
import type { DashboardStats } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest) {
  try {
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0); // local midnight

    const [devices, activeCaptures, runningNetCaptures, unackAlerts, criticalAlerts, mediaAssets, auditEvents, commandsToday] =
      await Promise.all([
        db.device.findMany(),
        db.mediaAsset.count({ where: { status: { in: ["requested", "capturing", "processing"] } } }),
        db.networkCapture.count({ where: { status: "running" } }),
        db.alert.count({ where: { acknowledged: false } }),
        db.alert.count({ where: { acknowledged: false, severity: "critical" } }),
        db.mediaAsset.count(),
        db.auditLog.count(),
        db.commandExecution.count({ where: { createdAt: { gte: midnight } } }),
      ]);

    const now = Date.now();
    const onlineDevices = devices.filter((d) => isEffectivelyOnline(d.status, d.lastSeen, now)).length;

    const stats: DashboardStats = {
      totalDevices: devices.length,
      onlineDevices,
      offlineDevices: devices.length - onlineDevices,
      commandsToday,
      activeCaptures,
      runningNetCaptures,
      unackAlerts,
      criticalAlerts,
      mediaAssets,
      auditEvents,
    };
    return ok(stats);
  } catch (e) {
    console.error("GET /api/stats failed", e);
    return err("Failed to compute stats", 500);
  }
}
