// ═══════════════════════════════════════════════════════════════════
// SentraRMM — Shared types & API contract
// This file is the single source of truth for frontend + backend.
// Backend (src/app/api/**) implements these routes.
// Frontend (src/components/dashboard/**) consumes them.
// Realtime hub (mini-services/agent-hub) implements the socket events.
// ═══════════════════════════════════════════════════════════════════

// ─────────────────────────── Core entities ─────────────────────────

export type DeviceStatus = "online" | "offline";
export type DeviceType = "workstation" | "laptop" | "server";

export interface Device {
  id: string;
  agentId: string;
  hostname: string;
  friendlyName: string | null;
  osName: string;
  osVersion: string;
  osArch: string;
  platform: string;
  cpuModel: string | null;
  cpuCores: number;
  totalMemoryMB: number;
  ipAddress: string | null;
  localIp: string | null;
  macAddress: string | null;
  agentVersion: string | null;
  deviceType: DeviceType;
  tags: string[]; // parsed from JSON
  status: DeviceStatus;
  lastSeen: string | null; // ISO
  firstSeen: string;
  locationLat: number | null;
  locationLon: number | null;
  locationLabel: string | null;
  notes: string | null;
  /** maintenance window — new alerts for this device are suppressed server-side */
  maintenance: boolean;
}

export type CommandStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "timeout";

export interface CommandExecution {
  id: string;
  deviceId: string;
  command: string;
  output: string | null;
  status: CommandStatus;
  exitCode: number | null;
  durationMs: number | null;
  shell: string;
  createdBy: string;
  createdAt: string;
  completedAt: string | null;
}

export type MediaKind =
  | "screenshot"
  | "screen_record"
  | "mic_record"
  | "camera_stream"
  | "call";
export type MediaStatus =
  | "requested"
  | "capturing"
  | "processing"
  | "available"
  | "failed"
  | "stopped";

export interface MediaAsset {
  id: string;
  deviceId: string;
  kind: MediaKind;
  status: MediaStatus;
  format: string | null;
  quality: string | null; // 480p | 720p | 1080p | source
  withMic: boolean;
  durationSec: number | null; // null/0 = indefinite
  sizeBytes: number | null;
  encrypted: boolean;
  encryptionNote: string | null;
  inMemory: boolean;
  dataRef: string | null; // data-URI / object URL for preview
  error: string | null;
  createdAt: string;
  completedAt: string | null;
}

export type CaptureStatus = "running" | "stopped" | "failed";

export interface NetworkCapture {
  id: string;
  deviceId: string;
  status: CaptureStatus;
  iface: string;
  filterBpf: string | null;
  tool: string;
  packets: number;
  bytesCaptured: number;
  outputPath: string | null;
  encrypted: boolean;
  notes: string | null;
  startedAt: string;
  stoppedAt: string | null;
}

export interface LocationPing {
  id: string;
  deviceId: string;
  lat: number;
  lon: number;
  accuracyM: number | null;
  label: string | null;
  source: "ip" | "gps" | "wifi";
  createdAt: string;
}

export type FileOpKind =
  | "list"
  | "download"
  | "upload"
  | "delete"
  | "rename"
  | "modify"
  | "mkdir";

export interface FileOperation {
  id: string;
  deviceId: string;
  op: FileOpKind;
  path: string;
  details: string | null;
  status: "ok" | "failed";
  sizeBytes: number | null;
  createdAt: string;
}

export interface ProcessSnapshot {
  id: string;
  deviceId: string;
  data: string; // JSON: ProcessInfo[]
  procCount: number;
  capturedAt: string;
}

export interface Alert {
  id: string;
  deviceId: string | null;
  title: string;
  message: string;
  severity: "info" | "warning" | "critical";
  acknowledged: boolean;
  ackedBy: string | null;
  acknowledgedAt: string | null;
  createdAt: string;
}

export interface AuditLog {
  id: string;
  deviceId: string | null;
  actor: string;
  action: string;
  detail: string | null;
  severity: "info" | "warning" | "critical";
  createdAt: string;
}

export interface SavedCommand {
  id: string;
  name: string;
  command: string;
  description: string | null;
  category: string;
  createdAt: string;
}

// ─────────────────────────── File browser ──────────────────────────

export interface FsEntry {
  name: string;
  path: string;
  type: "file" | "directory";
  sizeBytes: number;
  modifiedAt: string;
  hidden: boolean;
  ext?: string;
}

export interface FsListing {
  path: string;
  parent: string | null;
  drives: string[];
  entries: FsEntry[];
}

export interface FsDownload {
  path: string;
  name: string;
  sizeBytes: number;
  contentBase64: string;
  encryptedNote?: string;
}

// ─────────────────────────── Process info ──────────────────────────

export interface ProcessInfo {
  pid: number;
  name: string;
  cpuPercent: number;
  memoryMB: number;
  status: "running" | "suspended" | "stopped";
  user: string;
  path: string;
}

// ─────────────────────────── Live metrics ──────────────────────────

export interface DeviceMetrics {
  deviceId: string;
  cpuPercent: number;
  memoryPercent: number;
  diskPercent: number;
  uptimeSec: number;
  activeUsers: number;
  netUpKBps: number;
  netDownKBps: number;
  capturedAt: string;
}

// ─────────────────────── Telemetry history charts ──────────────────

/** One sampled utilization point (device heartbeat), ascending by time. */
export interface TelemetryPoint {
  t: number; // epoch ms
  cpu: number;
  memory: number;
  disk: number;
}

export interface TelemetryDeviceSeries {
  deviceId: string;
  minutes: number;
  points: TelemetryPoint[];
}

export interface TelemetryAllSeries {
  minutes: number;
  /** keyed by Device.id */
  series: Record<string, TelemetryPoint[]>;
}

// ─────────────────────────── Dashboard stats ───────────────────────

export interface DashboardStats {
  totalDevices: number;
  onlineDevices: number;
  offlineDevices: number;
  commandsToday: number;
  activeCaptures: number;
  runningNetCaptures: number;
  unackAlerts: number;
  criticalAlerts: number;
  mediaAssets: number;
  auditEvents: number;
}

// ─────────────────────── Device activity timeline ───────────────────

/** One merged entry of GET /api/devices/[id]/activity (reverse-chronological feed). */
export interface DeviceActivityEntry {
  id: string;
  type: "command" | "file" | "media" | "network" | "location" | "alert";
  title: string;
  detail?: string;
  status: string;
  severity: "info" | "warning" | "critical";
  at: string; // ISO timestamp
}


// ───────────────────────── Device health score ──────────────────────

/**
 * Composite 0-100 health score from live telemetry (frontend-computed).
 * 100 = idle healthy machine; deductions for CPU/MEM/DISK pressure + penalties
 * for stale telemetry or offline status.
 */
export function computeHealthScore(input: {
  online: boolean;
  cpuPercent?: number | null;
  memoryPercent?: number | null;
  diskPercent?: number | null;
  stale?: boolean;
}): number {
  if (!input.online) return 40;
  let score = 100;
  const cpu = input.cpuPercent ?? 0;
  const mem = input.memoryPercent ?? 0;
  const disk = input.diskPercent ?? 0;
  score -= Math.max(0, cpu - 30) * 0.5; // heavy CPU load hurts most
  score -= Math.max(0, mem - 55) * 0.6; // memory pressure is critical
  score -= Math.max(0, disk - 80) * 0.8; // nearly-full disks are a risk
  if (input.stale) score -= 10;
  return Math.max(0, Math.min(100, Math.round(score)));
}

// ─────────────────────────── Alert rules engine ────────────────────

export type AlertMetric = "cpu" | "memory" | "disk";
export type AlertRuleOp = "gt" | "lt";

/**
 * A threshold rule evaluated against every device heartbeat. Rules live in
 * the Setting table under key "alertRules" (JSON array). When a device's
 * telemetry crosses the threshold, an Alert row is created — rate-limited by
 * `cooldownMin` per device+rule and suppressed while maintenance is open.
 */
export interface AlertRule {
  id: string;
  name: string; // "High CPU load" — used in the alert title
  metric: AlertMetric;
  op: AlertRuleOp; // gt = above, lt = below
  threshold: number; // percent 0-100
  severity: "info" | "warning" | "critical";
  cooldownMin: number; // min minutes between repeat alerts for the same device
  enabled: boolean;
  /**
   * Optional tag scope — when set, the rule only evaluates against devices
   * whose tags include this value (e.g. "production"). null/undefined = all
   * devices.
   */
  deviceTag?: string | null;
}

export const DEFAULT_ALERT_RULES: AlertRule[] = [
  {
    id: "rule-cpu-high",
    name: "High CPU load",
    metric: "cpu",
    op: "gt",
    threshold: 60,
    severity: "warning",
    cooldownMin: 15,
    enabled: true,
  },
  {
    id: "rule-mem-pressure",
    name: "Memory pressure",
    metric: "memory",
    op: "gt",
    threshold: 65,
    severity: "warning",
    cooldownMin: 15,
    enabled: true,
  },
  {
    id: "rule-disk-full",
    name: "Disk almost full",
    metric: "disk",
    op: "gt",
    threshold: 70,
    severity: "warning",
    cooldownMin: 60,
    enabled: true,
  },
];

export const METRIC_LABELS: Record<AlertMetric, string> = {
  cpu: "CPU",
  memory: "Memory",
  disk: "Disk",
};

/** Human-readable condition, e.g. "CPU above 60%". */
export function describeRule(r: Pick<AlertRule, "metric" | "op" | "threshold">): string {
  return `${METRIC_LABELS[r.metric]} ${r.op === "gt" ? "above" : "below"} ${r.threshold}%`;
}

// ─────────────────────────── Settings blob ─────────────────────────

export interface AppSettings {
  capturePassword: string; // password used to encrypt stored artifacts
  retentionDays: number;
  defaultStreamQuality: "480p" | "720p" | "1080p";
  heartbeatIntervalSec: number;
  alertsOnOffline: boolean;
  alertsOnNewDevice: boolean;
  /** master switch for the threshold rules engine (individual rules also have their own flag) */
  alertRulesEnabled: boolean;
  inMemoryModeDefault: boolean;
  supabaseUrl: string;
  supabaseBucket: string;
  hubUrl: string;
}

export const DEFAULT_SETTINGS: AppSettings = {
  capturePassword: "",
  retentionDays: 30,
  defaultStreamQuality: "720p",
  heartbeatIntervalSec: 15,
  alertsOnOffline: true,
  alertsOnNewDevice: true,
  alertRulesEnabled: true,
  inMemoryModeDefault: true,
  supabaseUrl: "",
  supabaseBucket: "sentrarmm-artifacts",
  hubUrl: "http://127.0.0.1:3003",
};

// ───────────────────────────── API routes ──────────────────────────
// All routes return JSON. Shape: { ok: true, data } or { ok: false, error }.

export interface ApiOk<T> {
  ok: true;
  data: T;
}
export interface ApiErr {
  ok: false;
  error: string;
}
export type ApiResult<T> = ApiOk<T> | ApiErr;

/**
 * GET  /api/devices                     → Device[]
 * GET  /api/devices/[agentId|id]        → Device
 * POST /api/devices/[id]/notes          body: { notes }             → Device
 *
 * GET  /api/stats                       → DashboardStats
 *
 * GET  /api/metrics/history?deviceId=&minutes=30 → TelemetryDeviceSeries
 * GET  /api/metrics/history?minutes=30           → TelemetryAllSeries
 *
 * GET  /api/commands?deviceId=&limit=   → CommandExecution[]
 * POST /api/commands                    body: { deviceId, command } → CommandExecution (pending)
 * GET  /api/commands/[id]               → CommandExecution (poll for result)
 *
 * GET  /api/files?deviceId=&path=C:\    → FsListing        (sync via hub dispatch)
 * POST /api/files/upload                body: { deviceId, path, name, contentBase64 } → { ok }
 * POST /api/files/delete                body: { deviceId, path }                      → { ok }
 * POST /api/files/rename                body: { deviceId, path, newName }             → { ok }
 * POST /api/files/mkdir                 body: { deviceId, path }                      → { ok }
 * GET  /api/files/download?deviceId=&path= → FsDownload
 * GET  /api/files/operations?deviceId=  → FileOperation[]
 *
 * GET  /api/processes?deviceId=         → { snapshot: ProcessSnapshot|null, processes: ProcessInfo[], metrics: DeviceMetrics }
 * POST /api/processes/action            body: { deviceId, pid, action: "kill"|"suspend"|"resume" } → { ok }
 *
 * GET  /api/media?deviceId=&limit=      → MediaAsset[]
 * POST /api/media/screenshot            body: { deviceId }           → MediaAsset (with dataRef, sync)
 * POST /api/media/record                body: { deviceId, kind, quality, durationSec, withMic } → MediaAsset (async)
 * POST /api/media/stop                  body: { assetId }            → MediaAsset
 * POST /api/media/live                  body: { deviceId, action: "start"|"stop" } → { ok, agentId } (frames via socket `screen:frame`)
 * DELETE /api/media/[id]                → { ok }
 *
 * GET  /api/network?deviceId=           → NetworkCapture[]
 * POST /api/network/start               body: { deviceId, iface, filterBpf } → NetworkCapture
 * POST /api/network/stop                body: { deviceId }           → NetworkCapture
 *
 * GET  /api/location?deviceId=          → { device, pings: LocationPing[] }
 * POST /api/location/ping               body: { deviceId }           → LocationPing (fresh fix, sync)
 *
 * GET  /api/alerts?unackOnly=1&limit=   → Alert[]
 * POST /api/alerts/[id]/ack             → Alert
 * POST /api/alerts/clear-acked          → { deleted: number }
 *
 * GET  /api/alert-rules                 → AlertRule[]
 * PUT  /api/alert-rules                 body: AlertRule[] → AlertRule[] (full replace, validated)
 * POST /api/alert-rules/evaluate        body: { entries: [{ deviceId, hostname, cpu, memory, disk }] } → { fired, results }
 *
 * POST /api/devices/bulk                body: { ids, action: "maintenance"|"addTag"|"removeTag", value } → { updated }
 *
 * GET  /api/audit?deviceId=&limit=      → AuditLog[]
 *
 * GET  /api/saved-commands              → SavedCommand[]
 * POST /api/saved-commands              body: { name, command, description?, category? } → SavedCommand
 * DELETE /api/saved-commands/[id]       → { ok }
 *
 * GET  /api/settings                    → AppSettings
 * PUT  /api/settings                    body: Partial<AppSettings>   → AppSettings
 *
 * GET  /api/hub/status                  → { online: boolean, agents: { agentId, hostname, connected, lastSeen }[] }
 *
 * Internal (hub → api, shared-secret header x-hub-token):
 * POST /api/internal/heartbeat          body: { agentId, metrics, status, location? } → { ok, fired: Alert[] } (fired = rule-engine alerts, relayed by the hub)
 * POST /api/internal/devices/register   body: device info            → Device
 * POST /api/internal/commands/result    body: { commandId, status, output, exitCode, durationMs } → { ok }
 * POST /api/internal/media/result       body: { assetId, status, dataRef?, sizeBytes?, error? }   → { ok }
 * POST /api/internal/network/stats      body: { captureId, packets, bytesCaptured }               → { ok }
 * POST /api/internal/alerts             body: { deviceId?, title, message, severity }             → Alert
 * POST /api/internal/location           body: { agentId, lat, lon, accuracyM?, label?, source }   → { ok }
 */

// ───────────────────────── Socket.io contract ──────────────────────
// Hub runs on port 3003 (connect from browser: io("/?XTransformPort=3003", { path: "/" }))
//
// Client (dashboard) → hub:
//   "dashboard:join"            → joins "dashboard" room
// Hub → dashboard:
//   "device:update"   { device: Device }
//   "metrics:update"  { metrics: DeviceMetrics }
//   "command:result"  { command: CommandExecution }
//   "media:update"    { asset: MediaAsset }
//   "network:update"  { capture: NetworkCapture }
//   "alert:new"       { alert: Alert }
//   "screen:frame"    { agentId, dataUri, ts, seq, width, height }  (live screen viewer stream)
// Hub internal (agent ↔ hub):
//   "agent:register"  { info: AgentInfo }            ack → { ok }
//   "agent:heartbeat" { agentId, metrics, location? }
//   "agent:request"   { requestId, type, payload }   (hub → agent)
//   "agent:reply"     { requestId, ok, data?, error? } (agent → hub)
//
// agent request types handled by agents:
//   "exec"        { command }              → { output, exitCode, durationMs }
//   "fs:list"     { path }                 → FsListing
//   "fs:download" { path }                 → FsDownload
//   "fs:upload"   { path, name, contentBase64 } → { path }
//   "fs:delete"   { path }                 → { ok }
//   "fs:rename"   { path, newName }        → { path }
//   "fs:mkdir"    { path }                 → { path }
//   "ps:list"     {}                       → { processes: ProcessInfo[], metrics: DeviceMetrics }
//   "ps:action"   { pid, action }          → { ok }
//   "media:screenshot" { }                 → { dataUri, sizeBytes }
//   "media:record"     { assetId, kind, quality, durationSec, withMic } → ack { started } (async, results via HTTP)
//   "media:stop"       { assetId }          → { ok }
//   "net:start"   { captureId, iface, filterBpf } → ack { started } (stats via HTTP)
//   "net:stop"    { captureId }            → { packets, bytesCaptured }
//   "location:fix" {}                      → { lat, lon, accuracyM, label, source }
//   "screen:live:start" { fps }            → ack { started, fps } (frames via `screen:frame` until stop)
//   "screen:live:stop"  {}                 → { frames }

// ───────────────────────── Live screen viewer ───────────────────────

/** One pushed frame of the live screen viewer (socket event `screen:frame`). */
export interface ScreenFrame {
  agentId: string;
  dataUri: string;
  ts: number; // epoch ms at the agent
  seq: number; // monotonically increasing per stream
  width: number;
  height: number;
}

// ─────────────────────────── Helper types ──────────────────────────

export interface AgentInfo {
  agentId: string;
  hostname: string;
  friendlyName?: string;
  osName: string;
  osVersion: string;
  osArch: string;
  platform: string;
  cpuModel: string;
  cpuCores: number;
  totalMemoryMB: number;
  localIp: string;
  macAddress: string;
  agentVersion: string;
  deviceType: DeviceType;
  tags?: string[];
}

export const HUB_PORT = 3003;

// Client-side fetch helper contract (frontend should use this)
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...init,
  });
  const json = (await res.json()) as ApiResult<T>;
  if (!json.ok) throw new Error(json.error || "Request failed");
  return json.data;
}
