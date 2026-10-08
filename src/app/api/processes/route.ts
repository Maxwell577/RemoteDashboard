// GET  /api/processes?deviceId= → { snapshot, processes, metrics }
// POST /api/processes  body: { deviceId, pid, action } → { ok }
// (Contract alias /api/processes/action shares the same POST handler.)
import type { NextRequest } from "next/server";
import { db } from "@/lib/db";
import {
  coerceMetrics,
  coerceProcessList,
  err,
  handleProcessAction,
  ok,
  resolveDevice,
} from "@/lib/api-helpers";
import { dispatchToHub } from "@/lib/hub";
import { toProcessSnapshot } from "@/lib/serialize";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const deviceId = req.nextUrl.searchParams.get("deviceId");
    if (!deviceId) return err("deviceId is required", 400);
    const device = await resolveDevice(deviceId);
    if (!device) return err("Device not found", 404);

    const res = await dispatchToHub(device.agentId, "ps:list", {}, { deviceId: device.id });
    if (!res.ok) return err(res.error, 502);
    const d = (res.data && typeof res.data === "object" ? res.data : {}) as {
      processes?: unknown;
      metrics?: unknown;
    };
    const processes = coerceProcessList(d.processes);
    const metrics = coerceMetrics(d.metrics, device.id);

    const snapshot = await db.processSnapshot.create({
      data: {
        deviceId: device.id,
        data: JSON.stringify(processes),
        procCount: processes.length,
      },
    });
    return ok({
      snapshot: toProcessSnapshot(snapshot),
      processes,
      metrics,
    });
  } catch (e) {
    console.error("GET /api/processes failed", e);
    return err("Failed to list processes", 500);
  }
}

export async function POST(req: NextRequest) {
  return handleProcessAction(req);
}
