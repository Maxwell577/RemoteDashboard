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
import { Server, type Socket as IoSocket } from "socket.io";
import type { AgentInfo, DeviceMetrics } from "../../src/lib/types";
import { CONFIG, nextApi } from "./config";
import { SIM_DEVICE_DEFS } from "./sim/devices";
import { SimAgent } from "./sim/agent";
import { nowIso, postJson } from "./util";

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
  info?: AgentInfo;
}

interface AgentRecord {
  info: AgentInfo;
  connected: boolean;
  lastSeen: string;
  socketId: string | null;
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

const DASHBOARD_EVENTS = new Set(["media:update", "network:update", "alert:new", "screen:frame"]);
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
      void postJson(
        nextApi("/api/internal/heartbeat"),
        { agentId: msg.agentId, metrics: msg.metrics, status: "online", location: msg.location ?? null },
        HUB_HEADERS,
      );
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

    socket.on("disconnect", (reason: string) => this.onAgentDisconnect(socket, reason));
  }

  private onAgentDisconnect(socket: IoSocket, reason: string): void {
    if (this.stopping) return;
    for (const [agentId, rec] of this.agents) {
      if (rec.socketId !== socket.id) continue;
      rec.connected = false;
      rec.socketId = null;
      console.log(`[HUB] agent disconnected: ${agentId} (${reason})`);
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

    if (reply.ok && type === "exec") {
      const data = (reply.data ?? {}) as { output?: unknown; exitCode?: unknown; durationMs?: unknown };
      this.io.to("dashboard").emit("command:result", {
        commandId: typeof meta?.commandId === "string" ? meta.commandId : null,
        deviceId: typeof meta?.deviceId === "string" ? meta.deviceId : null,
        status: "completed",
        output: data.output ?? "",
        exitCode: typeof data.exitCode === "number" ? data.exitCode : 0,
        durationMs: typeof data.durationMs === "number" ? data.durationMs : null,
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
        this.json(res, 200, { ok: true, agents });
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
