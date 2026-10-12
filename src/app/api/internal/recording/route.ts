// POST /api/internal/recording  (hub → api, x-hub-token)
// Upsert by recordingId from hub-relayed agent events (record:status /
// record:manifest) → returns the full RecordingArtifact so the hub can
// broadcast `recording:update` to the dashboard room.
import type { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { asIntOrNull, asStringOrNull, err, isNotFound, ok, readBody, verifyHubToken } from "@/lib/api-helpers";
import { parseSources, toRecording } from "../../recordings/mapper";

export const dynamic = "force-dynamic";

const STATES = ["armed", "recording", "completed", "failed", "canceled"] as const;

export async function POST(req: NextRequest) {
  try {
    if (!verifyHubToken(req)) return err("Unauthorized", 401);
    const body = await readBody<Record<string, unknown>>(req);
    if (!body || typeof body.recordingId !== "string" || body.recordingId === "") {
      return err("recordingId is required", 400);
    }
    const recordingId = body.recordingId;

    const state =
      typeof body.state === "string" && (STATES as readonly string[]).includes(body.state) ? body.state : undefined;

    // elapsedSec is transient progress info — intentionally not persisted.
    const patch = {
      ...(state ? { state } : {}),
      ...(asStringOrNull(body.fileName) ? { fileName: asStringOrNull(body.fileName) } : {}),
      ...(asIntOrNull(body.sizeBytes) !== null ? { sizeBytes: asIntOrNull(body.sizeBytes) } : {}),
      ...(asStringOrNull(body.sha256) ? { sha256: asStringOrNull(body.sha256) } : {}),
      ...(asIntOrNull(body.frames) !== null ? { frames: asIntOrNull(body.frames) } : {}),
      ...(typeof body.error === "string" ? { error: body.error } : {}),
      ...(body.startedAt === null
        ? { startedAt: null }
        : asStringOrNull(body.startedAt)
          ? { startedAt: new Date(asStringOrNull(body.startedAt) as string) }
          : {}),
      ...(body.endedAt === null
        ? { endedAt: null }
        : asStringOrNull(body.endedAt)
          ? { endedAt: new Date(asStringOrNull(body.endedAt) as string) }
          : {}),
      ...(asIntOrNull(body.durationSec) !== null ? { durationSec: asIntOrNull(body.durationSec) as number } : {}),
      ...(body.label !== undefined ? { label: asStringOrNull(body.label) } : {}),
      ...(body.keyFingerprint && typeof body.keyFingerprint === "string"
        ? { keyFingerprint: body.keyFingerprint }
        : {}),
      ...(body.sources && typeof body.sources === "object"
        ? { sources: JSON.stringify(parseSources(JSON.stringify(body.sources)) ?? body.sources) }
        : {}),
    };

    const existing = await db.recordingArtifact.findUnique({ where: { recordingId } });
    if (existing) {
      const updated = await db.recordingArtifact.update({ where: { recordingId }, data: patch });
      return ok(toRecording(updated));
    }

    // Unknown recordingId (e.g. the dashboard DB was unavailable when the row
    // was created) — rebuild a minimal row from the relay payload.
    let deviceId = typeof body.deviceId === "string" ? body.deviceId : null;
    if (!deviceId && typeof body.agentId === "string") {
      const device = await db.device.findUnique({ where: { agentId: body.agentId } });
      deviceId = device?.id ?? null;
    }
    if (!deviceId) return err("Cannot create recording: unknown device (deviceId/agentId required)", 400);

    const created = await db.recordingArtifact.create({
      data: {
        recordingId,
        deviceId,
        durationSec: asIntOrNull(body.durationSec) ?? 0,
        state: state ?? "recording",
        ...patch,
      },
    });
    return ok(toRecording(created));
  } catch (e) {
    if (isNotFound(e)) return err("Recording not found", 404);
    console.error("POST /api/internal/recording failed", e);
    return err("Recording upsert failed", 500);
  }
}
