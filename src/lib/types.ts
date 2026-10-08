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

// ─────────────────────────── Settings blob ─────────────────────────

export interface AppSettings {
  capturePassword: string; // password used to encrypt stored artifacts
  retentionDays: number;
  defaultStreamQuality: "480p" | "720p" | "1080p";
  heartbeatIntervalSec: number;
  alertsOnOffline: boolean;
  alertsOnNewDevice: boolean;
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
 * POST /api/internal/heartbeat          body: { agentId, metrics, status, location? } → { ok }
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
