// Simulated scheduled recording (v0.3). Produces a REAL SENTRA-REC-1
// encrypted artifact — SVG "screen" frames + mic level records, each frame
// individually sealed with AES-256-GCM — and streams it to the hub with
// ordered, acked record:chunk events, then a record:manifest.
//
//   header line (JSON + \n): { magic, cipher, kdf, iterations, salt, agentId,
//                              label, durationSec, sources, startedAt }
//   framed records:          [u32 BE length][12B nonce][ciphertext][16B tag]
//     length = bytes AFTER the u32 (nonce + ciphertext + tag)
//     plaintext = JSON { t, kind: "screen"|"camera"|"mic", sourceId, mime?, dataB64?|level? }
//   key = PBKDF2-HMAC-SHA256(passphrase, salt, 200000, 32B)
//   AAD = sha256(recordingId) first 16 bytes
//
// Sim constraint: durationSec is hard-capped at 120s. Uploads continue (with
// retries) even while the hub is unreachable — frames keep buffering.
import { createCipheriv, createHash, pbkdf2Sync, randomBytes } from "node:crypto";
import type { Socket } from "socket.io-client";
import { sleep } from "../util";

export interface SimRecorderDeps {
  socket: Socket;
  agentId: string;
  hostname: string;
  recordingId: string;
  durationSec: number;
  passphrase: string;
  label: string | null;
  sources: { monitors?: string[]; cameras?: string[]; mics?: string[] };
  renderScreen: (sourceId: string) => { dataUri: string; width: number; height: number };
  renderCamera: (sourceId: string) => { dataUri: string; width: number; height: number };
  micLevel: (sourceId: string) => number;
  log: (msg: string) => void;
}

const ARM_DELAY_MS = 3_000;
const STATUS_EVERY_MS = 5_000;
const SCREEN_INTERVAL_MS = 500; // ~2 fps
const CAMERA_INTERVAL_MS = 1_000; // ~1 fps
const MIC_INTERVAL_MS = 125; // 8 Hz
const CHUNK_RAW_BYTES = 180 * 1024; // → base64 payload ≤ 256 KB
const SVG_PREFIX = "data:image/svg+xml;base64,";

type SimRecordingState = "armed" | "recording" | "finalizing" | "done";

export class SimRecorder {
  private readonly deps: SimRecorderDeps;
  private readonly salt = randomBytes(16);
  private readonly key: Buffer;
  private readonly aad: Buffer;
  private state: SimRecordingState = "armed";
  private readonly hash = createHash("sha256");
  private totalBytes = 0;
  private frames = 0;
  private nextSeq = 0;
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  private startedAt = 0;
  private readonly timers: ReturnType<typeof setTimeout>[] = [];
  private uploading = false;

  constructor(deps: SimRecorderDeps) {
    this.deps = deps;
    this.key = pbkdf2Sync(deps.passphrase, this.salt, 200000, 32, "sha256");
    this.aad = createHash("sha256").update(deps.recordingId).digest().subarray(0, 16);
    this.timers.push(setTimeout(() => void this.start(), ARM_DELAY_MS));
  }

  isDone(): boolean {
    return this.state === "done";
  }

  cancel(): void {
    if (this.state === "armed") {
      this.clearTimers();
      this.state = "done";
      this.deps.log(`recording ${this.deps.recordingId} canceled before start — on-device notice cleared`);
      void this.emitStatus({ state: "canceled", endedAt: new Date().toISOString() }, 1);
      return;
    }
    if (this.state === "recording") {
      this.deps.log(`recording ${this.deps.recordingId} canceled by the operator — finalizing artifact`);
      void this.finalize("canceled");
    }
  }

  // ── internals ───────────────────────────────────────────────────────────

  private clearTimers(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers.length = 0;
  }

  private async start(): Promise<void> {
    if (this.state !== "armed") return;
    this.state = "recording";
    this.startedAt = Date.now();
    const d = this.deps;
    // Header `sources` per the frozen contract: a flat array of selected source ids.
    const sourceIds = [
      ...(d.sources.monitors ?? []),
      ...(d.sources.cameras ?? []),
      ...(d.sources.mics ?? []),
    ];
    const header = Buffer.from(
      `${JSON.stringify({
        magic: "SENTRA-REC-1",
        cipher: "AES-256-GCM",
        kdf: "PBKDF2-HMAC-SHA256",
        iterations: 200000,
        salt: this.salt.toString("base64"),
        agentId: d.agentId,
        ...(d.label ? { label: d.label } : {}),
        durationSec: d.durationSec,
        sources: sourceIds,
        startedAt: this.startedAt,
      })}\n`,
      "utf8",
    );
    this.appendRaw(header);
    d.log(`recording ${d.recordingId} started (${d.durationSec}s, sources ${JSON.stringify(d.sources)}) — indicator visible on device`);

    void this.emitStatus({ state: "recording", startedAt: new Date(this.startedAt).toISOString() });

    const monitors = d.sources.monitors ?? [];
    if (monitors.length > 0) {
      this.timers.push(
        setInterval(() => {
          for (const sourceId of monitors) {
            const shot = d.renderScreen(sourceId);
            this.addRecord({
              t: Date.now(),
              kind: "screen",
              sourceId,
              mime: "image/svg+xml",
              dataB64: shot.dataUri.startsWith(SVG_PREFIX) ? shot.dataUri.slice(SVG_PREFIX.length) : shot.dataUri,
            });
          }
          if (this.pendingBytes >= CHUNK_RAW_BYTES) void this.flush();
        }, SCREEN_INTERVAL_MS),
      );
    }
    const cameras = d.sources.cameras ?? [];
    if (cameras.length > 0) {
      this.timers.push(
        setInterval(() => {
          for (const sourceId of cameras) {
            const shot = d.renderCamera(sourceId);
            this.addRecord({
              t: Date.now(),
              kind: "camera",
              sourceId,
              mime: "image/svg+xml",
              dataB64: shot.dataUri.startsWith(SVG_PREFIX) ? shot.dataUri.slice(SVG_PREFIX.length) : shot.dataUri,
            });
          }
          if (this.pendingBytes >= CHUNK_RAW_BYTES) void this.flush();
        }, CAMERA_INTERVAL_MS),
      );
    }
    const mics = d.sources.mics ?? [];
    if (mics.length > 0) {
      this.timers.push(
        setInterval(() => {
          for (const sourceId of mics) {
            this.addRecord({ t: Date.now(), kind: "mic", sourceId, level: d.micLevel(sourceId) });
          }
          if (this.pendingBytes >= CHUNK_RAW_BYTES) void this.flush();
        }, MIC_INTERVAL_MS),
      );
    }

    this.timers.push(setTimeout(() => void this.finalize("completed"), d.durationSec * 1000));
    this.timers.push(
      setInterval(() => {
        void this.emitStatus({
          state: "recording",
          elapsedSec: Math.round((Date.now() - this.startedAt) / 1000),
          sizeBytes: this.totalBytes,
          frames: this.frames,
        });
      }, STATUS_EVERY_MS),
    );
    void this.flush();
  }

  /** Append already-sealed bytes to the upload buffer + running file hash. */
  private appendRaw(buf: Buffer): void {
    this.hash.update(buf);
    this.totalBytes += buf.length;
    this.pending.push(buf);
    this.pendingBytes += buf.length;
  }

  /** Encrypt one plaintext record per the frozen .enc format and buffer it. */
  private addRecord(obj: Record<string, unknown>): void {
    const plaintext = Buffer.from(JSON.stringify(obj), "utf8");
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    cipher.setAAD(this.aad);
    const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const body = Buffer.concat([nonce, ct, cipher.getAuthTag()]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(body.length, 0);
    this.appendRaw(Buffer.concat([len, body]));
    this.frames += 1;
  }

  /** Drain the buffer as ordered, acked record:chunk events. */
  private async flush(): Promise<boolean> {
    if (this.uploading || this.state === "armed" || this.state === "done") return true;
    if (this.pending.length === 0) return true;
    this.uploading = true;
    try {
      while (this.pending.length > 0 && this.pendingBytes >= CHUNK_RAW_BYTES) {
        const ok = await this.sendNextChunk();
        if (!ok) return false;
      }
      return true;
    } finally {
      this.uploading = false;
    }
  }

  private async sendNextChunk(): Promise<boolean> {
    const parts: Buffer[] = [];
    let size = 0;
    while (this.pending.length > 0 && size < CHUNK_RAW_BYTES) {
      const b = this.pending[0]!;
      parts.push(b);
      size += b.length;
      this.pending.shift();
    }
    const chunk = Buffer.concat(parts);
    const seq = this.nextSeq;
    let lastErr = "";
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const ack = (await this.deps.socket.timeout(8000).emitWithAck("record:chunk", {
          recordingId: this.deps.recordingId,
          seq,
          dataB64: chunk.toString("base64"),
        })) as { ok?: boolean; error?: string } | undefined;
        if (ack?.ok) {
          this.nextSeq += 1;
          this.pendingBytes -= size;
          return true;
        }
        lastErr = ack?.error ?? "chunk rejected";
      } catch (e) {
        lastErr = e instanceof Error ? e.message : String(e);
      }
      await sleep(400);
    }
    this.pending.unshift(chunk); // re-queue intact; retried on the next flush
    this.deps.log(`record:chunk seq=${seq} failed after 3 attempts (${lastErr}) — buffering, will retry`);
    return false;
  }

  private async emitStatus(
    fields: { state?: string; elapsedSec?: number; sizeBytes?: number; frames?: number; startedAt?: string; endedAt?: string },
    attempts = 2,
  ): Promise<void> {
    for (let i = 0; i < attempts; i++) {
      try {
        const ack = (await this.deps.socket.timeout(6000).emitWithAck("record:status", {
          recordingId: this.deps.recordingId,
          ...fields,
        })) as { ok?: boolean } | undefined;
        if (ack?.ok) return;
      } catch {
        /* hub busy — retry */
      }
      await sleep(800);
    }
  }

  private async finalize(finalState: "completed" | "canceled"): Promise<void> {
    if (this.state === "finalizing" || this.state === "done") return;
    this.state = "finalizing";
    this.clearTimers();
    const d = this.deps;
    const endedAt = new Date().toISOString();

    // Flush everything; keep retrying for ~20s if the hub is unreachable.
    for (let i = 0; i < 10 && this.pending.length > 0; i++) {
      if (await this.flushAll()) break;
      await sleep(1500);
    }

    const sizeBytes = this.totalBytes;
    const sha256 = this.hash.digest("hex");
    const fileName = `${d.recordingId}.enc`;

    let manifestOk = false;
    for (let attempt = 1; attempt <= 3 && !manifestOk; attempt++) {
      try {
        const ack = (await d.socket.timeout(8000).emitWithAck("record:manifest", {
          recordingId: d.recordingId,
          fileName,
          sizeBytes,
          sha256,
        })) as { ok?: boolean; error?: string } | undefined;
        if (ack?.ok) manifestOk = true;
        else d.log(`record:manifest rejected (attempt ${attempt}): ${ack?.error ?? "unknown"}`);
      } catch (e) {
        d.log(`record:manifest failed (attempt ${attempt}): ${e instanceof Error ? e.message : e}`);
      }
      if (!manifestOk) await sleep(1200);
    }
    if (!manifestOk) {
      d.log(`recording ${d.recordingId}: manifest unacknowledged — artifact stays buffered locally`);
    }

    await this.emitStatus({ state: finalState, endedAt, sizeBytes, frames: this.frames }, 3);
    this.state = "done";
    d.log(
      `recording ${d.recordingId} ${finalState} — ${sizeBytes} bytes, ${this.frames} frames, sha256 ${sha256.slice(0, 12)}…${manifestOk ? "" : " (upload incomplete)"}`,
    );
  }

  /** Flush regardless of buffer fill (used at finalize). */
  private async flushAll(): Promise<boolean> {
    if (this.uploading) return false;
    if (this.pending.length === 0) return true;
    this.uploading = true;
    try {
      while (this.pending.length > 0) {
        const ok = await this.sendNextChunk();
        if (!ok) return false;
      }
      return true;
    } finally {
      this.uploading = false;
    }
  }
}
