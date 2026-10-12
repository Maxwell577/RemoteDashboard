// GET  /api/recordings?deviceId=&limit= → RecordingArtifact[]
// POST /api/recordings  body: { deviceId, durationSec, monitors?, cameras?, mics?, passphrase, label? }
//                       → RecordingArtifact (state "armed"); dispatches record:schedule.
// The passphrase is NEVER persisted or logged — only its sha256 fingerprint.
import crypto from "node:crypto";
import type { NextRequest } from "next/server";
import { db } from "@/lib/db";
import {
  err,
  intParam,
  isEffectivelyOnline,
  ok,
  readBody,
  resolveDevice,
  writeAudit,
} from "@/lib/api-helpers";
import { dispatchToHub } from "@/lib/hub";
import { ensureRecordingsDir, parseSources, toRecording } from "./mapper";

export const dynamic = "force-dynamic";

// Upper bound per the contract; the lower bound is relaxed to 15s so the
// simulated fleet (hard-capped at 120s) can complete short QA round-trips.
const MIN_DURATION_SEC = 15;
const MAX_DURATION_SEC = 28800; // 8 hours

const NOTICE_TEXT =
  "SentraRMM: a scheduled recording was armed by the administrator — a visible indicator will be shown while recording.";

export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams;
    const deviceId = sp.get("deviceId");
    const limit = intParam(sp, "limit", 50);
    const rows = await db.recordingArtifact.findMany({
      where: deviceId ? { deviceId } : undefined,
      orderBy: { createdAt: "desc" },
      take: limit,
    });
    return ok(rows.map(toRecording));
  } catch (e) {
    console.error("GET /api/recordings failed", e);
    return err("Failed to list recordings", 500);
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await readBody<{
      deviceId?: string;
      durationSec?: number;
      monitors?: unknown;
      cameras?: unknown;
      mics?: unknown;
      passphrase?: string;
      label?: string;
    }>(req);
    if (!body?.deviceId) return err("deviceId is required", 400);
    if (typeof body.passphrase !== "string" || body.passphrase.length < 8) {
      return err("passphrase is required (min 8 characters)", 400);
    }
    const durationSec = Math.round(Number(body.durationSec));
    if (!Number.isFinite(durationSec) || durationSec < MIN_DURATION_SEC || durationSec > MAX_DURATION_SEC) {
      return err(`durationSec must be between ${MIN_DURATION_SEC} and ${MAX_DURATION_SEC}`, 400);
    }
    const device = await resolveDevice(body.deviceId);
    if (!device) return err("Device not found", 404);
    if (!isEffectivelyOnline(device.status, device.lastSeen)) {
      return err("Device is offline — scheduling a recording requires an online device", 400);
    }

    const idList = (v: unknown): string[] | undefined =>
      Array.isArray(v) && v.length > 0 ? v.filter((x): x is string => typeof x === "string") : undefined;
    const sources = {
      ...(idList(body.monitors) ? { monitors: idList(body.monitors) } : {}),
      ...(idList(body.cameras) ? { cameras: idList(body.cameras) } : {}),
      ...(idList(body.mics) ? { mics: idList(body.mics) } : {}),
    };
    const passphrase = body.passphrase;
    const keyFingerprint = crypto.createHash("sha256").update(passphrase).digest("hex").slice(0, 12);
    const recordingId = crypto.randomUUID();
    const label = typeof body.label === "string" && body.label.trim() !== "" ? body.label.trim().slice(0, 200) : null;

    // Arm the agent first; only persist the row when the agent accepted.
    const res = await dispatchToHub<{ accepted?: unknown; state?: string }>(
      device.agentId,
      "record:schedule",
      {
        recordingId,
        durationSec,
        ...(sources.monitors ? { monitors: sources.monitors } : {}),
        ...(sources.cameras ? { cameras: sources.cameras } : {}),
        ...(sources.mics ? { mics: sources.mics } : {}),
        passphrase,
        ...(label ? { label } : {}),
        noticeText: NOTICE_TEXT,
      },
      { recordingId, deviceId: device.id },
    );
    if (!res.ok) {
      await writeAudit({
        deviceId: device.id,
        action: "recording.schedule",
        detail: `failed: ${res.error}`,
        severity: "warning",
      });
      return err(`Agent rejected the recording schedule: ${res.error}`, 502);
    }

    const row = await db.recordingArtifact.upsert({
      where: { recordingId },
      create: {
        recordingId,
        deviceId: device.id,
        label,
        durationSec,
        sources: JSON.stringify(sources),
        state: "armed",
        encryption: "AES-256-GCM",
        kdf: "PBKDF2-HMAC-SHA256",
        kdfIterations: 200000,
        keyFingerprint,
      },
      update: { state: "armed", label, durationSec, keyFingerprint },
    });

    ensureRecordingsDir();
    await writeAudit({
      deviceId: device.id,
      action: "recording.schedule",
      detail: `armed ${recordingId} · ${durationSec}s · sources=${JSON.stringify(sources)} · keyFingerprint=${keyFingerprint} · on-device notice shown`,
      severity: "info",
    });
    return ok(toRecording(row));
  } catch (e) {
    console.error("POST /api/recordings failed", e);
    return err("Failed to schedule recording", 500);
  }
}
