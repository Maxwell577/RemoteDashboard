// Shared helpers for the /api/recordings* routes + /api/internal/recording:
// Prisma row → RecordingArtifact DTO (frozen v0.3 contract) and the on-disk
// location of the encrypted .enc artifacts (db/recordings/<recordingId>.enc).
import fs from "node:fs";
import path from "node:path";
import type { RecordingArtifact as RecordingRow } from "@prisma/client";
import type { RecordingArtifact, RecordingState } from "@/lib/types";

const STATES: readonly RecordingState[] = ["armed", "recording", "completed", "failed", "canceled"];

export interface RecordingSources {
  monitors?: string[];
  cameras?: string[];
  mics?: string[];
}

/** Parse the sources JSON column; never throws, never returns non-object junk. */
export function parseSources(raw: string | null | undefined): RecordingSources | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const s = parsed as Record<string, unknown>;
    const arr = (v: unknown): string[] | undefined =>
      Array.isArray(v) && v.length > 0 ? v.filter((x): x is string => typeof x === "string") : undefined;
    const out: RecordingSources = {};
    const monitors = arr(s.monitors);
    const cameras = arr(s.cameras);
    const mics = arr(s.mics);
    if (monitors) out.monitors = monitors;
    if (cameras) out.cameras = cameras;
    if (mics) out.mics = mics;
    return Object.keys(out).length > 0 ? out : null;
  } catch {
    return null;
  }
}

function stateOf(value: string): RecordingState {
  return (STATES as readonly string[]).includes(value) ? (value as RecordingState) : "failed";
}

function iso(d: Date | null | undefined): string | null {
  return d ? d.toISOString() : null;
}

export function toRecording(row: RecordingRow): RecordingArtifact {
  return {
    id: row.id,
    recordingId: row.recordingId,
    deviceId: row.deviceId,
    label: row.label,
    durationSec: row.durationSec,
    sources: parseSources(row.sources),
    state: stateOf(row.state),
    fileName: row.fileName,
    sizeBytes: row.sizeBytes,
    sha256: row.sha256,
    encryption: row.encryption,
    kdf: row.kdf,
    kdfIterations: row.kdfIterations,
    keyFingerprint: row.keyFingerprint,
    frames: row.frames,
    error: row.error,
    startedAt: iso(row.startedAt),
    endedAt: iso(row.endedAt),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Absolute path of the db/recordings directory (override with RECORDINGS_DIR). */
export function recordingsDir(): string {
  return process.env.RECORDINGS_DIR?.trim() || path.join(process.cwd(), "db", "recordings");
}

/** Absolute path of one artifact file; guards against path traversal. */
export function recordingFilePath(recordingId: string): string {
  const safe = path.basename(recordingId);
  return path.join(recordingsDir(), `${safe}.enc`);
}

/** Ensure the recordings directory exists (mkdir -p). */
export function ensureRecordingsDir(): string {
  const dir = recordingsDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
