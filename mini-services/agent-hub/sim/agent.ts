// Simulated Windows agent. Connects to the hub over socket.io exactly like a
// real agent would (register → heartbeat → request/reply) and implements every
// agent-side request type from the SentraRMM contract.

import { io, type Socket } from "socket.io-client";
import type { DeviceMetrics } from "../../../src/lib/types";
import { CONFIG, nextApi } from "../config";
import { clamp, fmtBytes, jitter, pick, postJson, rndInt, round1, round4 } from "../util";
import { runCommand, type ExecContext } from "./exec";
import { runCommandCmd } from "./cmd";
import { svgDesktop, svgPoster, svgWebcam, toDataUri } from "./media";
import { ProcTable } from "./proc";
import { SimRecorder } from "./record";
import type { DeviceDef } from "./devices";
import { seedDeviceFs, type Vfs } from "./vfs";

interface RequestMsg {
  requestId: string;
  type: string;
  payload?: Record<string, unknown>;
}

interface MediaCapture {
  assetId: string;
  kind: string;
  quality: string;
  withMic: boolean;
  startedAt: number;
  bytesPerSec: number;
  timer: ReturnType<typeof setTimeout> | null;
}

interface NetCapture {
  captureId: string;
  iface: string;
  filterBpf: string | null;
  packets: number;
  bytesCaptured: number;
  timer: ReturnType<typeof setInterval> | null;
}

interface LiveStream {
  seq: number;
  fps: number;
  startedAt: number;
  timer: ReturnType<typeof setInterval> | null;
}

/** v0.3 multi-source stream (any number may run simultaneously). */
interface SimStream {
  streamId: string;
  kind: "screen" | "camera" | "mic";
  sourceId: string;
  fps: number;
  width: number;
  height: number;
  seq: number;
  timer: ReturnType<typeof setInterval> | null;
  startedAt: number;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

export class SimAgent {
  readonly vfs: Vfs;
  private readonly procTable: ProcTable;
  private readonly socket: Socket;
  private readonly bootTime: number;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private lastMetrics: DeviceMetrics | null = null;
  private cpuHistory: number[] = [];
  private readonly media = new Map<string, MediaCapture>();
  private readonly net = new Map<string, NetCapture>();
  private live: LiveStream | null = null;
  private readonly streams = new Map<string, SimStream>();
  private recorder: SimRecorder | null = null;
  private cmdCwd: string;
  private stopped = false;

  constructor(readonly def: DeviceDef) {
    this.vfs = seedDeviceFs(def);
    this.procTable = new ProcTable(def);
    this.bootTime = Date.now() - def.bootDaysAgo * 86_400_000 - rndInt(0, 3_600_000);
    this.cmdCwd = `C:\\Users\\${def.userName}`;
    this.socket = io(`http://127.0.0.1:${CONFIG.port}`, {
      path: "/",
      reconnectionDelayMax: 5000,
    });
  }

  start(): void {
    const s = this.socket;
    s.on("connect", () => {
      this.log(`connected to hub (socket ${s.id})`);
      s.emit(
        "agent:register",
        { info: { ...this.def.info, captures: this.def.captures } },
        (ack?: { ok?: boolean }) => {
          if (ack?.ok) this.log("registered (captures: monitors/cameras/mics/shells reported)");
          else this.log("registration rejected by hub");
        },
      );
      this.ensureHeartbeat();
    });
    s.on("disconnect", (reason: string) => {
      this.log(`disconnected from hub (${reason}) — will reconnect`);
      // v0.3 contract: agents stop streaming when they disconnect. Recordings
      // keep running and buffer chunks until the hub is reachable again.
      this.stopAllStreams();
    });
    s.on("connect_error", (err: Error) => {
      this.log(`hub connect error: ${err.message} — retrying`);
    });
    s.on("agent:request", (msg: RequestMsg) => {
      void this.onRequest(msg);
    });
  }

  stop(): void {
    this.stopped = true;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    for (const cap of this.media.values()) {
      if (cap.timer) clearTimeout(cap.timer);
    }
    this.media.clear();
    for (const cap of this.net.values()) {
      if (cap.timer) clearInterval(cap.timer);
    }
    this.net.clear();
    if (this.live?.timer) clearInterval(this.live.timer);
    this.live = null;
    this.stopAllStreams();
    if (this.recorder && !this.recorder.isDone()) this.recorder.cancel();
    this.recorder = null;
    this.socket.disconnect();
  }

  // ── telemetry ─────────────────────────────────────────────────────────

  private ensureHeartbeat(): void {
    if (this.heartbeatTimer || this.stopped) return;
    this.heartbeatTimer = setInterval(() => this.beat(), CONFIG.heartbeatSec * 1000);
  }

  private beat(): void {
    if (this.stopped || !this.socket.connected) return;
    const metrics = this.buildMetrics();
    this.socket.emit("agent:heartbeat", {
      agentId: this.def.info.agentId,
      metrics,
      location: this.locationFix(),
    });
    this.log(
      `heartbeat cpu=${metrics.cpuPercent}% mem=${metrics.memoryPercent}% disk=${metrics.diskPercent}% net=↑${metrics.netUpKBps}KBps ↓${metrics.netDownKBps}KBps`,
    );
  }

  private buildMetrics(): DeviceMetrics {
    const d = this.def;
    const m: DeviceMetrics = {
      deviceId: d.info.agentId,
      cpuPercent: round1(clamp(jitter(d.cpuBase, d.cpuSpread), 3, 85)),
      memoryPercent: round1(clamp(jitter(d.memBase, d.memSpread), 8, 96)),
      diskPercent: d.diskPercent,
      uptimeSec: Math.floor((Date.now() - this.bootTime) / 1000),
      activeUsers: pick(d.activeUsers),
      netUpKBps: Math.max(1, Math.round(jitter(d.netUpBase, d.netUpSpread))),
      netDownKBps: Math.max(1, Math.round(jitter(d.netDownBase, d.netDownSpread))),
      capturedAt: new Date().toISOString(),
    };
    this.lastMetrics = m;
    this.cpuHistory.push(m.cpuPercent);
    if (this.cpuHistory.length > 64) this.cpuHistory.shift();
    return m;
  }

  private execCtx(): ExecContext {
    const uptimeSec = Math.floor((Date.now() - this.bootTime) / 1000);
    return {
      def: this.def,
      procTable: this.procTable,
      vfs: this.vfs,
      uptimeSec,
      cpuPercent: this.lastMetrics?.cpuPercent ?? this.def.cpuBase,
      memPercent: this.lastMetrics?.memoryPercent ?? this.def.memBase,
      cwd: this.cmdCwd,
    };
  }

  // ── request handling ──────────────────────────────────────────────────

  private async onRequest(msg: RequestMsg): Promise<void> {
    if (this.stopped || !msg || typeof msg.requestId !== "string" || typeof msg.type !== "string") return;
    const payload = (msg.payload ?? {}) as Record<string, unknown>;
    try {
      const data = await this.handle(msg.type, payload);
      this.socket.emit("agent:reply", { requestId: msg.requestId, ok: true, data });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      this.socket.emit("agent:reply", { requestId: msg.requestId, ok: false, error });
      this.log(`${msg.type} failed: ${error}`);
    }
  }

  private async handle(type: string, p: Record<string, unknown>): Promise<unknown> {
    switch (type) {
      case "exec": {
        const command = str(p.command);
        const wanted = str(p.shell) || "powershell";
        const effective = wanted === "cmd" ? "cmd" : "powershell"; // sims always have powershell
        const ctx = this.execCtx();
        const r = effective === "cmd" ? await runCommandCmd(command, ctx) : await runCommand(command, ctx);
        this.cmdCwd = ctx.cwd; // cmd `cd` persists across commands
        this.log(
          `exec [${effective}] '${command}' ${r.exitCode === 0 ? "ok" : `exit ${r.exitCode}`} (${r.durationMs}ms)`,
        );
        return r;
      }
      case "fs:list":
        return this.vfs.list(str(p.path));
      case "fs:download":
        return this.vfs.download(str(p.path));
      case "fs:upload":
        return this.vfs.upload(str(p.path), str(p.name), str(p.contentBase64));
      case "fs:delete":
        return this.vfs.remove(str(p.path));
      case "fs:rename":
        return this.vfs.rename(str(p.path), str(p.newName));
      case "fs:mkdir":
        return this.vfs.mkdir(str(p.path));
      case "ps:list":
        return { processes: this.procTable.list(), metrics: this.buildMetrics() };
      case "ps:action": {
        const res = this.procTable.action(Number(p.pid), str(p.action));
        this.log(`ps:action ${str(p.action)} pid=${p.pid} ok`);
        return res;
      }
      case "media:screenshot":
        return this.screenshot();
      case "media:record":
        return this.startMediaRecord(p);
      case "media:stop":
        return this.stopMediaRecord(str(p.assetId));
      case "net:start":
        return this.startNetCapture(p);
      case "net:stop":
        return this.stopNetCapture(str(p.captureId));
      case "location:fix":
        return this.locationFix();
      case "screen:live:start":
        return this.startLiveStream(p);
      case "screen:live:stop":
        return this.stopLiveStream();
      case "stream:start":
        return this.startStream(p);
      case "stream:stop":
        return this.stopStream(str(p.streamId));
      case "record:schedule":
        return this.scheduleRecording(p);
      case "record:cancel":
        return this.cancelRecording(str(p.recordingId));
      default:
        throw new Error(`Unknown request type '${type}'`);
    }
  }

  // ── media ─────────────────────────────────────────────────────────────

  private screenshot(): { dataUri: string; sizeBytes: number } {
    const m = this.lastMetrics;
    const svg = svgDesktop({
      hostname: this.def.info.hostname,
      ip: this.def.info.localIp,
      osLabel: `${this.def.info.osName} ${this.def.info.osVersion}`,
      agentVersion: this.def.info.agentVersion,
      cpu: m?.cpuPercent ?? this.def.cpuBase,
      mem: m?.memoryPercent ?? this.def.memBase,
      disk: this.def.diskPercent,
      // jittered per call → consecutive live-view frames differ (net meters + clock seconds)
      netUpKBps: Math.max(4, Math.round(jitter(this.def.netUpBase, this.def.netUpSpread))),
      netDownKBps: Math.max(16, Math.round(jitter(this.def.netDownBase, this.def.netDownSpread))),
      uptimeSec: Math.floor((Date.now() - this.bootTime) / 1000),
      cpuHistory: this.cpuHistory,
      palette: this.def.palette,
      accent: this.def.accent,
      now: new Date(),
    });
    return { dataUri: toDataUri(svg), sizeBytes: Buffer.byteLength(svg, "utf8") };
  }

  private poster(cap: Pick<MediaCapture, "assetId" | "kind" | "quality">, elapsedSec: number): string {
    return toDataUri(
      svgPoster({
        hostname: this.def.info.hostname,
        kind: cap.kind,
        quality: cap.quality,
        assetId: cap.assetId,
        elapsedSec,
        palette: this.def.palette,
        accent: this.def.accent,
        camera: cap.kind === "camera_stream" || cap.kind === "call",
        mic: cap.kind === "mic_record",
      }),
    );
  }

  private startMediaRecord(p: Record<string, unknown>): { started: true } {
    const assetId = str(p.assetId) || `asset-${Date.now()}`;
    const kind = str(p.kind) || "screen_record";
    const quality = str(p.quality) || "720p";
    const withMic = p.withMic === true;
    const durationSec = typeof p.durationSec === "number" ? p.durationSec : 0;
    if (this.media.has(assetId)) throw new Error(`Capture '${assetId}' is already running`);

    const bytesPerSec =
      kind === "mic_record"
        ? 16_000
        : kind === "camera_stream" || kind === "call"
          ? 260_000
          : quality === "1080p"
            ? 760_000
            : quality === "480p"
              ? 190_000
              : quality === "source"
                ? 1_150_000
                : 390_000;

    const cap: MediaCapture = { assetId, kind, quality, withMic, startedAt: Date.now(), bytesPerSec, timer: null };
    this.media.set(assetId, cap);
    this.emitEvent("media:update", { id: assetId, status: "capturing", kind, quality, withMic });
    this.log(`media:record ${assetId} capturing (${kind}, ${quality}, ${durationSec > 0 ? `${durationSec}s` : "indefinite"})`);

    if (durationSec > 0) {
      cap.timer = setTimeout(() => {
        void this.finishMedia(cap, "available");
      }, Math.min(durationSec, 3600) * 1000);
    }
    return { started: true };
  }

  private stopMediaRecord(assetId: string): { ok: true } {
    const cap = this.media.get(assetId);
    if (!cap) {
      this.log(`media:stop ${assetId}: no active capture (already finished)`);
      return { ok: true };
    }
    void this.finishMedia(cap, "stopped");
    return { ok: true };
  }

  private async finishMedia(cap: MediaCapture, status: "available" | "stopped"): Promise<void> {
    if (cap.timer) {
      clearTimeout(cap.timer);
      cap.timer = null;
    }
    if (!this.media.has(cap.assetId) || this.stopped) return;
    this.media.delete(cap.assetId);
    const elapsed = (Date.now() - cap.startedAt) / 1000;
    const sizeBytes = Math.max(24_000, Math.round(cap.bytesPerSec * elapsed * (0.85 + Math.random() * 0.3)));
    const dataRef = this.poster(cap, elapsed);
    this.log(`media:record ${cap.assetId} ${status} (${fmtBytes(sizeBytes)}, ${Math.round(elapsed)}s)`);
    this.emitEvent("media:update", { id: cap.assetId, status, sizeBytes });
    await postJson(
      nextApi("/api/internal/media/result"),
      { assetId: cap.assetId, status, sizeBytes, dataRef },
      { "x-hub-token": CONFIG.hubToken },
    );
  }

  // ── live screen stream ────────────────────────────────────────────────

  private startLiveStream(p: Record<string, unknown>): { started: true; fps: number } {
    if (this.live) throw new Error("A live screen stream is already running");
    const fps = Math.min(3, Math.max(0.5, typeof p.fps === "number" && p.fps > 0 ? p.fps : 1));
    const stream: LiveStream = { seq: 0, fps, startedAt: Date.now(), timer: null };
    this.live = stream;
    const interval = Math.round(1000 / fps);
    stream.timer = setInterval(() => {
      if (!this.live || this.stopped || !this.socket.connected) return;
      stream.seq += 1;
      const shot = this.screenshot();
      this.socket.emit("agent:event", {
        name: "screen:frame",
        payload: {
          agentId: this.def.info.agentId,
          dataUri: shot.dataUri,
          ts: Date.now(),
          seq: stream.seq,
          width: 1600,
          height: 900,
        },
      });
    }, interval);
    this.log(`screen:live started (${fps} fps)`);
    return { started: true, fps };
  }

  private stopLiveStream(): { frames: number } {
    const stream = this.live;
    if (!stream) return { frames: 0 };
    if (stream.timer) clearInterval(stream.timer);
    this.live = null;
    this.log(`screen:live stopped (${stream.seq} frames streamed)`);
    return { frames: stream.seq };
  }

  // ── v0.3 multi-source streams ─────────────────────────────────────────

  private num(v: unknown): number | null {
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  }

  private startStream(p: Record<string, unknown>): { started: true; meta: Record<string, unknown> } {
    const streamId = str(p.streamId);
    if (!streamId) throw new Error("streamId is required");
    const kind = str(p.kind);
    if (kind !== "screen" && kind !== "camera" && kind !== "mic") {
      throw new Error("kind must be one of: screen, camera, mic");
    }
    if (this.streams.has(streamId)) throw new Error(`Stream '${streamId}' is already running`);
    const caps = this.def.captures;

    let stream: SimStream;
    let meta: Record<string, unknown>;
    if (kind === "screen") {
      const sourceId = str(p.sourceId) || caps.monitors[0]?.id || "monitor:0";
      const idx = caps.monitors.findIndex((m) => m.id === sourceId);
      if (idx < 0) {
        throw new Error(
          `Unknown monitor '${sourceId}' — available: ${caps.monitors.map((m) => m.id).join(", ") || "none"}`,
        );
      }
      const mon = caps.monitors[idx]!;
      const fps = clamp(this.num(p.fps) ?? 2, 0.5, 5);
      stream = { streamId, kind, sourceId, fps, width: mon.width, height: mon.height, seq: 0, timer: null, startedAt: Date.now() };
      meta = { width: mon.width, height: mon.height, fps, sourceId, name: mon.name, primary: mon.primary };
    } else if (kind === "camera") {
      const sourceId = str(p.sourceId) || caps.cameras[0]?.id || "camera:0";
      const idx = caps.cameras.findIndex((c) => c.id === sourceId);
      if (idx < 0) {
        throw new Error(`Unknown camera '${sourceId}' — available: ${caps.cameras.map((c) => c.id).join(", ") || "none"}`);
      }
      const fps = clamp(this.num(p.fps) ?? 10, 1, 15);
      stream = { streamId, kind, sourceId, fps, width: 1280, height: 720, seq: 0, timer: null, startedAt: Date.now() };
      meta = { width: 1280, height: 720, fps, sourceId, name: caps.cameras[idx]!.name };
    } else {
      const sourceId = str(p.sourceId) || caps.mics[0]?.id || "mic:0";
      const idx = caps.mics.findIndex((m) => m.id === sourceId);
      if (idx < 0) {
        throw new Error(`Unknown mic '${sourceId}' — available: ${caps.mics.map((m) => m.id).join(", ") || "none"}`);
      }
      stream = { streamId, kind, sourceId, fps: 8, width: 0, height: 0, seq: 0, timer: null, startedAt: Date.now() };
      meta = { fps: 8, sourceId, name: caps.mics[idx]!.name };
    }

    this.streams.set(streamId, stream);
    const interval = Math.round(1000 / stream.fps);
    stream.timer = setInterval(() => this.emitStreamFrame(stream), interval);
    this.log(`stream:start ${kind} '${stream.sourceId}' @${stream.fps}fps (streamId ${streamId.slice(0, 8)}…, ${this.streams.size} active)`);
    return { started: true, meta };
  }

  private emitStreamFrame(stream: SimStream): void {
    if (this.stopped || !this.socket.connected) return;
    stream.seq += 1;
    const frame: Record<string, unknown> = {
      agentId: this.def.info.agentId,
      streamId: stream.streamId,
      kind: stream.kind,
      ts: Date.now(),
      seq: stream.seq,
    };
    if (stream.kind === "screen") {
      // render at the monitor's advertised resolution so frames match meta
      const shot = this.renderScreenSource(stream.sourceId, stream.width, stream.height);
      frame.dataUri = shot.dataUri;
      frame.width = shot.width;
      frame.height = shot.height;
    } else if (stream.kind === "camera") {
      const idx = Math.max(0, this.def.captures.cameras.findIndex((c) => c.id === stream.sourceId));
      const shot = this.renderCameraSource(stream.sourceId, idx);
      frame.dataUri = shot.dataUri;
      frame.width = 1280;
      frame.height = 720;
    } else {
      frame.level = this.micLevel();
    }
    this.socket.emit("agent:event", { name: "stream:frame", payload: frame });
  }

  private stopStream(streamId: string): { frames: number } {
    const stream = this.streams.get(streamId);
    if (!stream) return { frames: 0 };
    if (stream.timer) clearInterval(stream.timer);
    this.streams.delete(streamId);
    this.log(`stream:stop ${stream.kind} '${stream.sourceId}' (${stream.seq} frames streamed, ${this.streams.size} active)`);
    return { frames: stream.seq };
  }

  private stopAllStreams(): void {
    for (const stream of this.streams.values()) {
      if (stream.timer) clearInterval(stream.timer);
    }
    if (this.streams.size > 0) {
      this.log(`all ${this.streams.size} active stream(s) stopped (agent disconnect)`);
    }
    this.streams.clear();
  }

  /** SVG desktop render for a monitor source (variant 1 = second display). */
  private renderScreenSource(sourceId: string, w: number, h: number): { dataUri: string; width: number; height: number } {
    const idx = Math.max(0, this.def.captures.monitors.findIndex((m) => m.id === sourceId));
    const m = this.lastMetrics;
    const svg = svgDesktop({
      hostname: this.def.info.hostname,
      ip: this.def.info.localIp,
      osLabel: `${this.def.info.osName} ${this.def.info.osVersion}`,
      agentVersion: this.def.info.agentVersion,
      cpu: m?.cpuPercent ?? this.def.cpuBase,
      mem: m?.memoryPercent ?? this.def.memBase,
      disk: this.def.diskPercent,
      netUpKBps: Math.max(4, Math.round(jitter(this.def.netUpBase, this.def.netUpSpread))),
      netDownKBps: Math.max(16, Math.round(jitter(this.def.netDownBase, this.def.netDownSpread))),
      uptimeSec: Math.floor((Date.now() - this.bootTime) / 1000),
      cpuHistory: this.cpuHistory,
      palette: this.def.palette,
      accent: this.def.accent,
      now: new Date(),
      w,
      h,
      variant: idx === 0 ? 0 : 1,
    });
    return { dataUri: toDataUri(svg), width: w, height: h };
  }

  private renderCameraSource(sourceId: string, idx: number): { dataUri: string; width: number; height: number } {
    const cam = this.def.captures.cameras[idx] ?? { id: sourceId, name: "Camera" };
    const svg = svgWebcam({
      hostname: this.def.info.hostname,
      cameraId: cam.id,
      cameraName: cam.name,
      elapsedSec: (Date.now() - this.bootTime) / 1000,
      now: new Date(),
      accent: this.def.accent,
      variant: idx % 2,
    });
    return { dataUri: toDataUri(svg), width: 1280, height: 720 };
  }

  /** Mic input level 0.05..0.9 (sinusoid + noise), 8 Hz cadence. */
  private micLevel(): number {
    const t = Date.now() / 1000;
    const base = 0.475 + 0.32 * Math.sin(t * 2.2) + 0.1 * Math.sin(t * 5.7);
    const noise = (Math.random() * 2 - 1) * 0.08;
    return Number(clamp(base + noise, 0.05, 0.9).toFixed(3));
  }

  // ── v0.3 scheduled recordings ─────────────────────────────────────────

  private scheduleRecording(p: Record<string, unknown>): { accepted: true; state: "armed" } {
    const recordingId = str(p.recordingId);
    if (!recordingId) throw new Error("recordingId is required");
    if (this.recorder && !this.recorder.isDone()) {
      throw new Error("A recording is already active on this device");
    }
    const passphrase = str(p.passphrase);
    if (!passphrase) throw new Error("passphrase is required");
    const durationSec = clamp(Math.round(this.num(p.durationSec) ?? 0), 5, 120); // sim hard cap: 120s
    const list = (v: unknown): string[] | undefined =>
      Array.isArray(v) && v.length > 0 ? v.filter((x): x is string => typeof x === "string") : undefined;
    const sources = {
      ...(list(p.monitors) ? { monitors: list(p.monitors) } : {}),
      ...(list(p.cameras) ? { cameras: list(p.cameras) } : {}),
      ...(list(p.mics) ? { mics: list(p.mics) } : {}),
    };
    const label = str(p.label) || null;
    this.log(
      `record:schedule ${recordingId} armed (${durationSec}s) — on-device notice shown, indicator will be visible while recording`,
    );
    this.recorder = new SimRecorder({
      socket: this.socket,
      agentId: this.def.info.agentId,
      hostname: this.def.info.hostname,
      recordingId,
      durationSec,
      passphrase,
      label,
      sources,
      renderScreen: (sourceId) => this.renderScreenSource(sourceId, 1280, 720),
      renderCamera: (sourceId) =>
        this.renderCameraSource(sourceId, Math.max(0, this.def.captures.cameras.findIndex((c) => c.id === sourceId))),
      micLevel: () => this.micLevel(),
      log: (msg) => this.log(msg),
    });
    return { accepted: true, state: "armed" };
  }

  private cancelRecording(recordingId: string): { ok: true; state: string } {
    if (!this.recorder || this.recorder.isDone()) {
      this.log(`record:cancel ${recordingId}: no active recording`);
      return { ok: true, state: "idle" };
    }
    this.recorder.cancel();
    return { ok: true, state: "canceled" };
  }

  // ── network capture ───────────────────────────────────────────────────

  private startNetCapture(p: Record<string, unknown>): { started: true } {
    const captureId = str(p.captureId) || `cap-${Date.now()}`;
    if (this.net.has(captureId)) throw new Error(`Capture '${captureId}' is already running`);
    const cap: NetCapture = {
      captureId,
      iface: str(p.iface) || "Ethernet",
      filterBpf: str(p.filterBpf) || null,
      packets: 0,
      bytesCaptured: 0,
      timer: null,
    };
    this.net.set(captureId, cap);
    cap.timer = setInterval(() => {
      cap.packets += rndInt(20, 80);
      cap.bytesCaptured += rndInt(2_048, 61_440);
      this.emitEvent("network:update", {
        id: captureId,
        status: "running",
        packets: cap.packets,
        bytesCaptured: cap.bytesCaptured,
      });
      void postJson(
        nextApi("/api/internal/network/stats"),
        { captureId, packets: cap.packets, bytesCaptured: cap.bytesCaptured },
        { "x-hub-token": CONFIG.hubToken },
      );
    }, 3000);
    this.log(`net:capture ${captureId} started on ${cap.iface}${cap.filterBpf ? ` (bpf: ${cap.filterBpf})` : ""}`);
    return { started: true };
  }

  private stopNetCapture(captureId: string): { packets: number; bytesCaptured: number } {
    const cap = this.net.get(captureId);
    if (!cap) throw new Error(`No active capture '${captureId}'`);
    if (cap.timer) {
      clearInterval(cap.timer);
      cap.timer = null;
    }
    this.net.delete(captureId);
    this.log(`net:capture ${captureId} stopped (${cap.packets} packets, ${fmtBytes(cap.bytesCaptured)})`);
    this.emitEvent("network:update", {
      id: captureId,
      status: "stopped",
      packets: cap.packets,
      bytesCaptured: cap.bytesCaptured,
    });
    return { packets: cap.packets, bytesCaptured: cap.bytesCaptured };
  }

  // ── location ──────────────────────────────────────────────────────────

  private locationFix(): { lat: number; lon: number; accuracyM: number; label: string; source: "ip" } {
    const base = this.def.location;
    return {
      lat: round4(jitter(base.lat, 0.01)),
      lon: round4(jitter(base.lon, 0.01)),
      accuracyM: rndInt(12, 80),
      label: base.label,
      source: "ip",
    };
  }

  // ── misc ──────────────────────────────────────────────────────────────

  private emitEvent(name: string, payload: Record<string, unknown>): void {
    this.socket.emit("agent:event", { name, payload });
  }

  private log(msg: string): void {
    console.log(`[SIM:${this.def.info.hostname}] ${msg}`);
  }
}
