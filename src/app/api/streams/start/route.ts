// POST /api/streams/start  body: { deviceId, kind, sourceId?, fps?, quality? }
// → { streamId, meta? } — generates a dashboard-owned streamId and dispatches
// the v0.3 "stream:start" agent request (frames flow agent → hub → dashboard
// as push-only `stream:frame` events; see src/lib/types.ts).
import crypto from "node:crypto";
import type { NextRequest } from "next/server";
import { err, ok, readBody, resolveDevice, writeAudit } from "@/lib/api-helpers";
import { dispatchToHub } from "@/lib/hub";

export const dynamic = "force-dynamic";

const KINDS = ["screen", "camera", "mic"] as const;

export async function POST(req: NextRequest) {
  try {
    const body = await readBody<{
      deviceId?: string;
      kind?: string;
      sourceId?: string | null;
      fps?: number;
      quality?: string;
    }>(req);
    if (!body?.deviceId) return err("deviceId is required", 400);
    if (!body.kind || !(KINDS as readonly string[]).includes(body.kind)) {
      return err("kind must be one of: screen, camera, mic", 400);
    }
    const device = await resolveDevice(body.deviceId);
    if (!device) return err("Device not found", 404);

    const kind = body.kind;
    const sourceId = typeof body.sourceId === "string" && body.sourceId !== "" ? body.sourceId : null;
    const fps = typeof body.fps === "number" && Number.isFinite(body.fps) && body.fps > 0 ? body.fps : undefined;
    const quality =
      typeof body.quality === "string" && ["480p", "720p", "1080p", "source"].includes(body.quality)
        ? body.quality
        : undefined;
    const streamId = crypto.randomUUID();

    const res = await dispatchToHub<{ started?: unknown; meta?: Record<string, unknown> }>(
      device.agentId,
      "stream:start",
      { streamId, kind, sourceId, ...(fps !== undefined ? { fps } : {}), ...(quality ? { quality } : {}) },
      { streamId, deviceId: device.id },
      10_000,
    );
    if (!res.ok) {
      await writeAudit({
        deviceId: device.id,
        action: "stream.start",
        detail: `${kind} ${sourceId ?? "default"} failed: ${res.error}`,
        severity: "warning",
      });
      return err(res.error, 502);
    }

    await writeAudit({
      deviceId: device.id,
      action: "stream.start",
      detail: `${kind} · source=${sourceId ?? "default"}${fps ? ` · ${fps}fps` : ""} · streamId=${streamId} · frames are visible to the device user`,
      severity: "info",
    });

    const meta = res.data && typeof res.data === "object" ? (res.data.meta ?? null) : null;
    return ok({ streamId, agentId: device.agentId, kind, meta });
  } catch (e) {
    console.error("POST /api/streams/start failed", e);
    return err("Failed to start stream", 500);
  }
}
