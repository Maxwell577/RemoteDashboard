// SentraRMM agent hub: socket.io broker + tiny HTTP API on a single port.
//
//  - Dashboard clients emit `dashboard:join` and receive live events in the
//    "dashboard" room (device:update, metrics:update, command:result, ...).
//  - Agents emit `agent:register` / `agent:heartbeat` / `agent:event` and
//    answer `agent:request` with `agent:reply`.
//  - Device registrations, heartbeats and offline alerts are relayed to the
//    Next.js internal API; every relay failure is caught and retried on the
//    next natural occasion so the hub never crashes when Next.js is down.
//  - POST /dispatch routes a request to an agent and awaits its reply.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import fs from "node:fs";
import path from "node:path";
import { Server, type Socket as IoSocket } from "socket.io";
import type { AgentInfo, DeviceMetrics } from "../../src/lib/types";
import { CONFIG, ensureRecordingsDir, nextApi } from "./config";
import { SIM_DEVICE_DEFS } from "./sim/devices";
import { SimAgent } from "./sim/agent";
import { nowIso, postJson, postJsonBody } from "./util";

interface LocationHint {
  lat: number;
  lon: number;
  accuracyM?: number;
  label?: string;
  source?: string;
}

interface HeartbeatMsg {
  agentId: string;
  metrics: DeviceMetrics;
  location?: LocationHint | null;
}

interface AgentEventMsg {
  name: string;
  payload?: unknown;
}

interface ReplyMsg {
  requestId: string;
  ok: boolean;
  data?: unknown;
  error?: string;
}

interface RegisterMsg {
  info?: AgentInfo & { captures?: unknown };
}

interface AgentRecord {
  info: AgentInfo & { captures?: unknown };
  connected: boolean;
  lastSeen: string;
  socketId: string | null;
}

interface ActiveStream {
  agentId: string;
  kind: string;
}

interface RecordStatusMsg {
  recordingId?: unknown;
  state?: unknown;
  elapsedSec?: unknown;
  sizeBytes?: unknown;
  frames?: unknown;
  error?: unknown;
  startedAt?: unknown;
  endedAt?: unknown;
}

interface RecordChunkMsg {
  recordingId?: unknown;
  seq?: unknown;
  dataB64?: unknown;
}

interface RecordManifestMsg {
  recordingId?: unknown;
  fileName?: unknown;
  sizeBytes?: unknown;
  sha256?: unknown;
}

interface PendingReply {
  resolve: (r: ReplyMsg) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface DispatchResult {
  ok: boolean;
  data?: unknown;
  error?: string;
}

const DASHBOARD_EVENTS = new Set([
  "media:update",
  "network:update",
  "alert:new",
  "screen:frame",
  "stream:frame", // v0.3 multi-source stream frames (agent → hub → dashboard, push-only)
]);
const HUB_HEADERS = { "x-hub-token": CONFIG.hubToken };

function deviceFromInfo(info: AgentInfo, status: "online" | "offline"): Record<string, unknown> {
  return {
    agentId: info.agentId,
    hostname: info.hostname,
    friendlyName: info.friendlyName ?? null,
    osName: info.osName,
    osVersion: info.osVersion,
    osArch: info.osArch,
    platform: info.platform,
    cpuModel: info.cpuModel,
    cpuCores: info.cpuCores,
    totalMemoryMB: info.totalMemoryMB,
    ipAddress: info.localIp,
    localIp: info.localIp,
    macAddress: info.macAddress,
    agentVersion: info.agentVersion,
    deviceType: info.deviceType,
    tags: info.tags ?? [],
    status,
    lastSeen: nowIso(),
  };
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > 25 * 1024 * 1024) {
        reject(new Error("Payload too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      try {
        resolve(chunks.length ? (JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>) : null);
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

export class Hub {
  private io!: Server;
  private readonly httpServer = createServer();
  private readonly agents = new Map<string, AgentRecord>();
  private readonly pendingReplies = new Map<string, PendingReply>();
  private readonly pendingRegister = new Set<string>();
  /** v0.3 multi-stream registry: streamId → owning agent + kind. */
  private readonly activeStreams = new Map<string, ActiveStream>();
  /** record:chunk ordering: recordingId → next expected seq. */
  private readonly chunkNextSeq = new Map<string, number>();
  /** record:chunk bookkeeping: recordingId → bytes appended so far. */
  private readonly chunkBytes = new Map<string, number>();
  private sims: SimAgent[] = [];
  private readonly startedAt = Date.now();
  private stopping = false;

  start(): void {
    this.io = new Server(this.httpServer, {
      path: "/",
      cors: { origin: "*", methods: ["GET", "POST"] },
      pingTimeout: 60000,
      pingInterval: 25000,
    });
    this.io.on("connection", (s) => this.onConnection(s));

    // Engine.io matches its path with a plain prefix check, so path "/" would
    // claim EVERY http request (even /health). Intercept our HTTP routes
    // before engine.io sees them; everything else is delegated untouched.
    type EngineLike = { handleRequest: (req: IncomingMessage, res: ServerResponse) => void };
    const engine = this.io.engine as unknown as EngineLike;
    const engineHandleRequest = engine.handleRequest.bind(engine);
    engine.handleRequest = (req, res) => {
      if (res.writableEnded || res.headersSent) return;
      if (this.tryRouteHttp(req, res)) return;
      engineHandleRequest(req, res);
    };

    this.httpServer.listen(CONFIG.port, () => {
      console.log(
        `[HUB] agent hub listening on :${CONFIG.port} (socket.io path "/", HTTP /health /agents /dispatch)`,
      );
    });

    this.startSims();
  }

  stop(): void {
    if (this.stopping) return;
    this.stopping = true;
    for (const sim of this.sims) {
      try {
        sim.stop();
      } catch {
        /* ignore */
      }
    }
    this.sims = [];
    for (const [id, p] of this.pendingReplies) {
      clearTimeout(p.timer);
      p.resolve({ requestId: id, ok: false, error: "Hub shutting down" });
    }
    this.pendingReplies.clear();
    try {
      this.io?.close();
    } catch {
      /* already closed */
    }
    try {
      this.httpServer.close();
    } catch {
      /* already closed */
    }
    console.log("[HUB] stopped");
  }

  // ── socket.io side ────────────────────────────────────────────────────

  private onConnection(socket: IoSocket): void {
    socket.on("dashboard:join", () => {
      void socket.join("dashboard");
    });

    socket.on("agent:register", (msg: RegisterMsg, ack?: (r: unknown) => void) => {
      const info = msg?.info;
      if (!info || typeof info.agentId !== "string" || info.agentId === "") {
        ack?.({ ok: false, error: "info.agentId is required" });
        return;
      }
      socket.join(`agent:${info.agentId}`);
      this.agents.set(info.agentId, { info, connected: true, lastSeen: nowIso(), socketId: socket.id });
      ack?.({ ok: true });
      console.log(`[HUB] agent registered: ${info.agentId} (${info.hostname})`);
      this.io.to("dashboard").emit("device:update", { device: deviceFromInfo(info, "online") });
      void this.pushRegister(info);
    });

    socket.on("agent:heartbeat", (msg: HeartbeatMsg) => {
      if (!msg || typeof msg.agentId !== "string" || !msg.metrics) return;
      const rec = this.agents.get(msg.agentId);
      if (rec) rec.lastSeen = nowIso();
      this.io.to("dashboard").emit("metrics:update", { metrics: msg.metrics });
      void this.pushHeartbeat(msg.agentId, msg);
      // Registration POST failed earlier → retry on every heartbeat.
      if (rec && this.pendingRegister.has(msg.agentId)) void this.pushRegister(rec.info);
    });

    socket.on("agent:event", (msg: AgentEventMsg) => {
      if (!msg || typeof msg.name !== "string" || !DASHBOARD_EVENTS.has(msg.name)) return;
      this.io.to("dashboard").emit(msg.name, msg.payload ?? null);
    });

    socket.on("agent:reply", (msg: ReplyMsg) => {
      if (!msg || typeof msg.requestId !== "string") return;
      const pending = this.pendingReplies.get(msg.requestId);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pendingReplies.delete(msg.requestId);
      pending.resolve(msg);
    });

    // v0.3: belt-and-braces stop from the dashboard for orphaned streams.
    socket.on("stream:stop", (msg: { agentId?: unknown; streamId?: unknown }, ack?: (r: unknown) => void) => {
      const agentId = typeof msg?.agentId === "string" ? msg.agentId : "";
      const streamId = typeof msg?.streamId === "string" ? msg.streamId : "";
      if (!agentId || !streamId) {
        ack?.({ ok: false, error: "agentId and streamId are required" });
        return;
      }
      const rec = this.agents.get(agentId);
      const agentSocket = rec?.connected && rec.socketId ? this.io.sockets.sockets.get(rec.socketId) : undefined;
      if (!agentSocket) {
        ack?.({ ok: false, error: `Agent '${agentId}' is not connected` });
        return;
      }
      const requestId = crypto.randomUUID();
      const timer = setTimeout(() => {
        this.pendingReplies.delete(requestId);
        ack?.({ ok: false, error: "agent did not reply within 10000ms" });
      }, 10_000);
      this.pendingReplies.set(requestId, {
        resolve: (r) => {
          const frames = (r.data && typeof r.data === "object" ? (r.data as { frames?: unknown }).frames : null);
          ack?.({ ok: r.ok, frames: typeof frames === "number" ? frames : 0, ...(r.ok ? {} : { error: r.error }) });
          if (r.ok) {
            this.activeStreams.delete(streamId);
            this.io.to("dashboard").emit("stream:ended", {
              agentId,
              streamId,
              frames: typeof frames === "number" ? frames : 0,
              reason: "stopped by dashboard",
            });
          }
        },
        timer,
      });
      agentSocket.emit("agent:request", { requestId, type: "stream:stop", payload: { streamId } });
    });

    // v0.3 recording relays (agent → hub → Next internal API + dashboard).
    socket.on("record:status", (msg: RecordStatusMsg, ack?: (r: unknown) => void) =>
      this.onRecordStatus(socket, msg, ack),
    );
    socket.on("record:chunk", (msg: RecordChunkMsg, ack?: (r: unknown) => void) => this.onRecordChunk(msg, ack));
    socket.on("record:manifest", (msg: RecordManifestMsg, ack?: (r: unknown) => void) =>
      this.onRecordManifest(socket, msg, ack),
    );

    socket.on("disconnect", (reason: string) => this.onAgentDisconnect(socket, reason));
  }

  private onAgentDisconnect(socket: IoSocket, reason: string): void {
    if (this.stopping) return;
    for (const [agentId, rec] of this.agents) {
      if (rec.socketId !== socket.id) continue;
      rec.connected = false;
      rec.socketId = null;
      console.log(`[HUB] agent disconnected: ${agentId} (${reason})`);
      // v0.3: the contract requires agents to stop streaming on disconnect;
      // the hub mirrors that by ending every still-registered stream.
      for (const [streamId, stream] of this.activeStreams) {
        if (stream.agentId !== agentId) continue;
        this.activeStreams.delete(streamId);
        this.io.to("dashboard").emit("stream:ended", {
          agentId,
          streamId,
          frames: 0,
          reason: `agent disconnected (${reason})`,
        });
      }
      this.io.to("dashboard").emit("device:update", { device: { agentId, status: "offline" } });
      // persist the offline status so the device list doesn't show a ghost
      // "online" device until the next heartbeat gap
      void postJson(
        nextApi("/api/internal/heartbeat"),
        { agentId, status: "offline" },
        HUB_HEADERS,
      );
      void postJson(
        nextApi("/api/internal/alerts"),
        {
          title: "Device went offline",
          message: `${rec.info.hostname} disconnected from the hub`,
          severity: "warning",
          deviceId: null,
          agentIdHint: agentId,
          agentId,
        },
        HUB_HEADERS,
      );
    }
  }

  private async pushRegister(info: AgentInfo): Promise<void> {
    const ok = await postJson(nextApi("/api/internal/devices/register"), { ...info }, HUB_HEADERS);
    if (ok) this.pendingRegister.delete(info.agentId);
    else this.pendingRegister.add(info.agentId);
  }

  /**
   * Relay an agent heartbeat to the internal API and surface any alerts the
   * threshold rules engine fired for this telemetry as realtime `alert:new`
   * events (so they toast + sound in the dashboard like every other alert).
   */
  private async pushHeartbeat(agentId: string, msg: HeartbeatMsg): Promise<void> {
    const body = await postJsonBody(
      nextApi("/api/internal/heartbeat"),
      { agentId, metrics: msg.metrics, status: "online", location: msg.location ?? null },
      HUB_HEADERS,
    );
    if (!body) return;
    const envelope = body.data && typeof body.data === "object" ? (body.data as Record<string, unknown>) : body;
    const fired = envelope.fired;
    if (Array.isArray(fired)) {
      for (const alert of fired) {
        if (alert && typeof alert === "object") {
          this.io.to("dashboard").emit("alert:new", { alert });
        }
      }
      if (fired.length > 0) {
        console.log(`[HUB] rule engine fired ${fired.length} alert(s) for ${agentId}`);
      }
    }
  }

  // ── recording relays (v0.3) ───────────────────────────────────────────────

  /** Relay an agent's record:status to Next and broadcast the upserted artifact. */
  private async onRecordStatus(socket: IoSocket, msg: RecordStatusMsg, ack?: (r: unknown) => void): Promise<void> {
    const recordingId = typeof msg?.recordingId === "string" ? msg.recordingId : "";
    if (!recordingId) {
      ack?.({ ok: false, error: "recordingId is required" });
      return;
    }
    const agentId = this.agentIdForSocket(socket);
    const body: Record<string, unknown> = { recordingId, ...(agentId ? { agentId } : {}) };
    for (const key of ["state", "sizeBytes", "frames", "error", "startedAt", "endedAt"] as const) {
      if (msg[key] !== undefined) body[key] = msg[key];
    }
    const resp = await postJsonBody(nextApi("/api/internal/recording"), body, HUB_HEADERS);
    if (resp) {
      const recording = resp.data ?? resp;
      this.io.to("dashboard").emit("recording:update", { recording });
      ack?.({ ok: true });
    } else {
      console.warn(`[HUB] record:status relay for ${recordingId} failed — agent should retry`);
      ack?.({ ok: false, error: "recording store unavailable" });
    }
  }

  /** Append an ordered, decoded record:chunk to db/recordings/<recordingId>.enc. */
  private onRecordChunk(msg: RecordChunkMsg, ack?: (r: unknown) => void): void {
    const recordingId = typeof msg?.recordingId === "string" ? msg.recordingId : "";
    const seq = typeof msg?.seq === "number" ? msg.seq : NaN;
    const dataB64 = typeof msg?.dataB64 === "string" ? msg.dataB64 : "";
    if (!recordingId || !Number.isFinite(seq) || dataB64 === "") {
      ack?.({ ok: false, error: "recordingId, seq and dataB64 are required" });
      return;
    }
    if (dataB64.length > Math.ceil((CONFIG.chunkMaxPayloadBytes * 4) / 3)) {
      ack?.({ ok: false, error: `chunk payload exceeds ${CONFIG.chunkMaxPayloadBytes} bytes` });
      return;
    }
    const expected = this.chunkNextSeq.get(recordingId) ?? 0;
    if (seq !== expected) {
      // The agent retries with the same seq until the hub confirms it.
      ack?.({ ok: false, error: `out-of-order chunk: expected ${expected}, got ${seq}` });
      return;
    }
    let buf: Buffer;
    try {
      buf = Buffer.from(dataB64, "base64");
    } catch {
      ack?.({ ok: false, error: "invalid base64 payload" });
      return;
    }
    try {
      ensureRecordingsDir();
      const file = path.join(CONFIG.recordingsDir, `${path.basename(recordingId)}.enc`);
      fs.appendFileSync(file, buf);
      this.chunkBytes.set(recordingId, (this.chunkBytes.get(recordingId) ?? 0) + buf.length);
      this.chunkNextSeq.set(recordingId, expected + 1);
      ack?.({ ok: true, bytes: buf.length });
    } catch (err) {
      console.warn(`[HUB] record:chunk append failed for ${recordingId}: ${err instanceof Error ? err.message : err}`);
      ack?.({ ok: false, error: "failed to append chunk" });
    }
  }

  /** Verify uploaded bytes match the manifest, persist state=completed, broadcast. */
  private async onRecordManifest(
    socket: IoSocket,
    msg: RecordManifestMsg,
    ack?: (r: unknown) => void,
  ): Promise<void> {
    const recordingId = typeof msg?.recordingId === "string" ? msg.recordingId : "";
    const fileName = typeof msg?.fileName === "string" ? msg.fileName : "";
    const sizeBytes = typeof msg?.sizeBytes === "number" ? msg.sizeBytes : NaN;
    const sha256 = typeof msg?.sha256 === "string" ? msg.sha256 : "";
    if (!recordingId || !fileName || !Number.isFinite(sizeBytes) || !sha256) {
      ack?.({ ok: false, error: "recordingId, fileName, sizeBytes and sha256 are required" });
      return;
    }
    const received = this.chunkBytes.get(recordingId) ?? 0;
    if (received !== sizeBytes) {
      ack?.({
        ok: false,
        error: `size mismatch: manifest says ${sizeBytes}, hub received ${received} bytes`,
      });
      return;
    }
    const agentId = this.agentIdForSocket(socket);
    const resp = await postJsonBody(
      nextApi("/api/internal/recording"),
      {
        recordingId,
        ...(agentId ? { agentId } : {}),
        state: "completed",
        fileName,
        sizeBytes,
        sha256,
        endedAt: nowIso(),
      },
      HUB_HEADERS,
    );
    if (!resp) {
      ack?.({ ok: false, error: "recording store unavailable" });
      return;
    }
    this.chunkNextSeq.delete(recordingId);
    this.chunkBytes.delete(recordingId);
    const recording = resp.data ?? resp;
    this.io.to("dashboard").emit("recording:update", { recording });
    console.log(`[HUB] recording ${recordingId} completed (${sizeBytes} bytes, sha256 ${sha256.slice(0, 12)}…)`);
    ack?.({ ok: true });
  }

  private agentIdForSocket(socket: IoSocket): string | null {
    for (const [agentId, rec] of this.agents) {
      if (rec.socketId === socket.id) return agentId;
    }
    return null;
  }

  // ── dispatch ──────────────────────────────────────────────────────────

  private async dispatch(
    agentId: string,
    type: string,
    payload: unknown,
    meta?: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<DispatchResult> {
    const timeout = Math.max(1000, timeoutMs ?? 20_000);
    const rec = this.agents.get(agentId);
    const socket = rec?.connected && rec.socketId ? this.io.sockets.sockets.get(rec.socketId) : undefined;
    if (!socket) return { ok: false, error: `Agent '${agentId}' is not connected to the hub` };

    const requestId = crypto.randomUUID();
    const reply = await new Promise<ReplyMsg>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingReplies.delete(requestId);
        resolve({ requestId, ok: false, error: `Agent '${agentId}' did not reply within ${timeout}ms` });
      }, timeout);
      this.pendingReplies.set(requestId, { resolve, timer });
      socket.emit("agent:request", { requestId, type, payload });
    });

    // v0.3 stream registry: track streams the agent accepted / stopped.
    if (type === "stream:start" || type === "stream:stop") {
      const p = (payload ?? {}) as { streamId?: unknown; kind?: unknown };
      const streamId = typeof p.streamId === "string" ? p.streamId : "";
      if (streamId) {
        if (reply.ok && type === "stream:start") {
          this.activeStreams.set(streamId, {
            agentId,
            kind: typeof p.kind === "string" ? p.kind : "screen",
          });
        } else if (reply.ok && type === "stream:stop") {
          this.activeStreams.delete(streamId);
        }
      }
    }

    if (reply.ok && type === "stream:stop") {
      // Tell the dashboard room the stream ended (mirrors the belt-and-braces path).
      const p = (payload ?? {}) as { streamId?: unknown };
      const data = (reply.data ?? {}) as { frames?: unknown };
      this.io.to("dashboard").emit("stream:ended", {
        agentId,
        streamId: typeof p.streamId === "string" ? p.streamId : "",
        frames: typeof data.frames === "number" ? data.frames : 0,
        reason: "stopped by dashboard",
      });
    }

    if (reply.ok && type === "exec") {
      const data = (reply.data ?? {}) as { output?: unknown; exitCode?: unknown; durationMs?: unknown; shell?: unknown };
      this.io.to("dashboard").emit("command:result", {
        commandId: typeof meta?.commandId === "string" ? meta.commandId : null,
        deviceId: typeof meta?.deviceId === "string" ? meta.deviceId : null,
        status: "completed",
        output: data.output ?? "",
        exitCode: typeof data.exitCode === "number" ? data.exitCode : 0,
        durationMs: typeof data.durationMs === "number" ? data.durationMs : null,
        shell: typeof data.shell === "string" ? data.shell : null,
      });
    }

    return reply.ok
      ? { ok: true, data: reply.data }
      : { ok: false, error: reply.error ?? "Agent reported an error" };
  }

  // ── HTTP side ─────────────────────────────────────────────────────────

  /** Handle our HTTP routes; returns false when the request is not ours. */
  private tryRouteHttp(req: IncomingMessage, res: ServerResponse): boolean {
    const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    if (pathname !== "/health" && pathname !== "/agents" && pathname !== "/dispatch") {
      return false;
    }
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-hub-token");
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return true;
    }
    try {
      if (req.method === "GET" && pathname === "/health") {
        this.json(res, 200, { ok: true, uptimeSec: Math.round((Date.now() - this.startedAt) / 1000) });
        return true;
      }
      if (req.method === "GET" && pathname === "/agents") {
        const agents = [...this.agents.values()].map((r) => ({
          agentId: r.info.agentId,
          hostname: r.info.hostname,
          connected: r.connected,
          lastSeen: r.lastSeen,
        }));
        const activeStreams = [...this.activeStreams.entries()].map(([streamId, s]) => ({
          streamId,
          agentId: s.agentId,
          kind: s.kind,
        }));
        this.json(res, 200, { ok: true, agents, activeStreams, activeStreamCount: activeStreams.length });
        return true;
      }
      if (req.method === "POST" && pathname === "/dispatch") {
        void this.handleDispatch(req, res);
        return true;
      }
      this.json(res, 405, { ok: false, error: "Method not allowed" });
      return true;
    } catch (err) {
      this.json(res, 500, { ok: false, error: err instanceof Error ? err.message : "Internal hub error" });
      return true;
    }
  }

  private async handleDispatch(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const body = await readJson(req);
      const agentId = typeof body?.agentId === "string" ? body.agentId : "";
      const type = typeof body?.type === "string" ? body.type : "";
      if (!agentId || !type) {
        this.json(res, 400, { ok: false, error: "agentId and type are required" });
        return;
      }
      const meta =
        body && typeof body.meta === "object" && body.meta !== null ? (body.meta as Record<string, unknown>) : undefined;
      const timeoutMs = typeof body?.timeoutMs === "number" ? body.timeoutMs : undefined;
      const result = await this.dispatch(agentId, type, body?.payload ?? {}, meta, timeoutMs);
      this.json(res, 200, result);
    } catch (err) {
      this.json(res, err instanceof Error && /Invalid JSON|Payload/.test(err.message) ? 400 : 500, {
        ok: false,
        error: err instanceof Error ? err.message : "Internal hub error",
      });
    }
  }

  private json(res: ServerResponse, status: number, body: unknown): void {
    if (res.writableEnded || res.headersSent) return;
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  }

  // ── simulated agents ──────────────────────────────────────────────────

  private startSims(): void {
    for (const def of SIM_DEVICE_DEFS) {
      const sim = new SimAgent(def);
      this.sims.push(sim);
      sim.start();
    }
    console.log(`[HUB] ${this.sims.length} simulated agents starting (SIM-WKS-001, SIM-HOME-002, SIM-SRV-003)`);
  }
}
