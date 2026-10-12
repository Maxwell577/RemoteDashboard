// GET    /api/recordings/[id] → RecordingArtifact   (accepts DB id OR recordingId)
// DELETE /api/recordings/[id] → { ok }              (cancels armed/recording via
// record:cancel, deletes the .enc artifact file, then deletes the row)
import fs from "node:fs";
import type { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { err, isNotFound, ok, writeAudit } from "@/lib/api-helpers";
import { dispatchToHub } from "@/lib/hub";
import { recordingFilePath, toRecording } from "../mapper";

export const dynamic = "force-dynamic";

async function resolveRecording(id: string) {
  const byId = await db.recordingArtifact.findUnique({ where: { id } });
  if (byId) return byId;
  return db.recordingArtifact.findUnique({ where: { recordingId: id } });
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const row = await resolveRecording(id);
    if (!row) return err("Recording not found", 404);
    return ok(toRecording(row));
  } catch (e) {
    console.error("GET /api/recordings/[id] failed", e);
    return err("Failed to load recording", 500);
  }
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const row = await resolveRecording(id);
    if (!row) return err("Recording not found", 404);

    let cancelNote = "not needed";
    if (row.state === "armed" || row.state === "recording") {
      const device = await db.device.findUnique({ where: { id: row.deviceId } });
      if (device) {
        const res = await dispatchToHub(device.agentId, "record:cancel", { recordingId: row.recordingId });
        cancelNote = res.ok ? "canceled on agent" : `cancel failed: ${res.error}`;
      } else {
        cancelNote = "device missing — cancel skipped";
      }
    }

    const filePath = recordingFilePath(row.recordingId);
    let fileNote = "no file";
    try {
      if (fs.existsSync(filePath)) {
        const { size } = fs.statSync(filePath);
        fs.rmSync(filePath);
        fileNote = `${size} bytes removed`;
      }
    } catch (e) {
      fileNote = `file removal failed: ${e instanceof Error ? e.message : String(e)}`;
    }

    await db.recordingArtifact.delete({ where: { id: row.id } });
    await writeAudit({
      deviceId: row.deviceId,
      action: "recording.delete",
      detail: `${row.recordingId} (${row.state}) · agent: ${cancelNote} · artifact: ${fileNote}`,
      severity: "warning",
    });
    return ok({ ok: true });
  } catch (e) {
    if (isNotFound(e)) return err("Recording not found", 404);
    console.error("DELETE /api/recordings/[id] failed", e);
    return err("Failed to delete recording", 500);
  }
}
