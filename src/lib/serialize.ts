// SentraRMM — Prisma row → client DTO mappers.
// SQLite rows carry JSON-in-string fields + Date objects; the API contract
// (src/lib/types.ts) wants parsed arrays and ISO date strings.
import type {
  Device as DeviceRow,
  CommandExecution as CommandRow,
  MediaAsset as MediaRow,
  NetworkCapture as NetworkRow,
  LocationPing as PingRow,
  FileOperation as FileOpRow,
  ProcessSnapshot as SnapshotRow,
  Alert as AlertRow,
  AuditLog as AuditRow,
  SavedCommand as SavedRow,
} from "@prisma/client";
import type {
  Alert,
  AuditLog,
  CaptureStatus,
  CommandExecution,
  CommandStatus,
  Device,
  DeviceStatus,
  DeviceType,
  FileOperation,
  FileOpKind,
  LocationPing,
  MediaAsset,
  MediaKind,
  MediaStatus,
  NetworkCapture,
  ProcessInfo,
  ProcessSnapshot,
  SavedCommand,
} from "@/lib/types";

// ─────────────────────────── primitives ────────────────────────────

function iso(d: Date | null | undefined): string | null {
  return d ? d.toISOString() : null;
}

export function parseTags(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((t) => (typeof t === "string" ? t : String(t)));
  } catch {
    return [];
  }
}

/** Safely parse a ProcessSnapshot.data JSON blob into ProcessInfo[]. */
export function parseProcessData(raw: string | null | undefined): ProcessInfo[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (p): p is ProcessInfo =>
        !!p &&
        typeof p === "object" &&
        typeof (p as ProcessInfo).pid === "number" &&
        typeof (p as ProcessInfo).name === "string",
    );
  } catch {
    return [];
  }
}

// ───────────────────────── enum coercion ───────────────────────────
// Values are stored as plain strings; coerce defensively so the client
// never sees an out-of-contract literal.

const STATUSES: readonly DeviceStatus[] = ["online", "offline"];
const DEVICE_TYPES: readonly DeviceType[] = ["workstation", "laptop", "server"];
const COMMAND_STATUSES: readonly CommandStatus[] = ["pending", "running", "completed", "failed", "timeout"];
const MEDIA_KINDS: readonly MediaKind[] = ["screenshot", "screen_record", "mic_record", "camera_stream", "call"];
const MEDIA_STATUSES: readonly MediaStatus[] = [
  "requested",
  "capturing",
  "processing",
  "available",
  "failed",
  "stopped",
];
const CAPTURE_STATUSES: readonly CaptureStatus[] = ["running", "stopped", "failed"];
const FILE_OP_KINDS: readonly FileOpKind[] = [
  "list",
  "download",
  "upload",
  "delete",
  "rename",
  "modify",
  "mkdir",
];
const PING_SOURCES = ["ip", "gps", "wifi"] as const;

function oneOf<T extends string>(value: string, allowed: readonly T[], fallback: T): T {
  return (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

// ───────────────────────────── mappers ─────────────────────────────

export function toDevice(row: DeviceRow): Device {
  return {
    id: row.id,
    agentId: row.agentId,
    hostname: row.hostname,
    friendlyName: row.friendlyName,
    osName: row.osName,
    osVersion: row.osVersion,
    osArch: row.osArch,
    platform: row.platform,
    cpuModel: row.cpuModel,
    cpuCores: row.cpuCores,
    totalMemoryMB: row.totalMemoryMB,
    ipAddress: row.ipAddress,
    localIp: row.localIp,
    macAddress: row.macAddress,
    agentVersion: row.agentVersion,
    deviceType: oneOf(row.deviceType, DEVICE_TYPES, "workstation"),
    tags: parseTags(row.tags),
    status: oneOf(row.status, STATUSES, "offline"),
    lastSeen: iso(row.lastSeen),
    firstSeen: row.firstSeen.toISOString(),
    locationLat: row.locationLat,
    locationLon: row.locationLon,
    locationLabel: row.locationLabel,
    notes: row.notes,
  };
}

export function toCommand(row: CommandRow): CommandExecution {
  return {
    id: row.id,
    deviceId: row.deviceId,
    command: row.command,
    output: row.output,
    status: oneOf(row.status, COMMAND_STATUSES, "pending"),
    exitCode: row.exitCode,
    durationMs: row.durationMs,
    shell: row.shell,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    completedAt: iso(row.completedAt),
  };
}

export function toMedia(row: MediaRow): MediaAsset {
  return {
    id: row.id,
    deviceId: row.deviceId,
    kind: oneOf(row.kind, MEDIA_KINDS, "screenshot"),
    status: oneOf(row.status, MEDIA_STATUSES, "requested"),
    format: row.format,
    quality: row.quality,
    withMic: row.withMic,
    durationSec: row.durationSec,
    sizeBytes: row.sizeBytes,
    encrypted: row.encrypted,
    encryptionNote: row.encryptionNote,
    inMemory: row.inMemory,
    dataRef: row.dataRef,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
    completedAt: iso(row.completedAt),
  };
}

export function toCapture(row: NetworkRow): NetworkCapture {
  return {
    id: row.id,
    deviceId: row.deviceId,
    status: oneOf(row.status, CAPTURE_STATUSES, "stopped"),
    iface: row.iface,
    filterBpf: row.filterBpf,
    tool: row.tool,
    packets: row.packets,
    bytesCaptured: row.bytesCaptured,
    outputPath: row.outputPath,
    encrypted: row.encrypted,
    notes: row.notes,
    startedAt: row.startedAt.toISOString(),
    stoppedAt: iso(row.stoppedAt),
  };
}

export function toPing(row: PingRow): LocationPing {
  return {
    id: row.id,
    deviceId: row.deviceId,
    lat: row.lat,
    lon: row.lon,
    accuracyM: row.accuracyM,
    label: row.label,
    source: oneOf(row.source, PING_SOURCES, "ip"),
    createdAt: row.createdAt.toISOString(),
  };
}

export function toFileOp(row: FileOpRow): FileOperation {
  return {
    id: row.id,
    deviceId: row.deviceId,
    op: oneOf(row.op, FILE_OP_KINDS, "list"),
    path: row.path,
    details: row.details,
    status: row.status === "failed" ? "failed" : "ok",
    sizeBytes: row.sizeBytes,
    createdAt: row.createdAt.toISOString(),
  };
}

export function toProcessSnapshot(row: SnapshotRow): ProcessSnapshot {
  return {
    id: row.id,
    deviceId: row.deviceId,
    data: row.data,
    procCount: row.procCount,
    capturedAt: row.capturedAt.toISOString(),
  };
}

const SEVERITIES = ["info", "warning", "critical"] as const;
type Severity = (typeof SEVERITIES)[number];

function severityOf(value: string): Severity {
  return oneOf(value, SEVERITIES, "info");
}

export function toAlert(row: AlertRow): Alert {
  return {
    id: row.id,
    deviceId: row.deviceId,
    title: row.title,
    message: row.message,
    severity: severityOf(row.severity),
    acknowledged: row.acknowledged,
    ackedBy: row.ackedBy,
    acknowledgedAt: iso(row.acknowledgedAt),
    createdAt: row.createdAt.toISOString(),
  };
}

export function toAudit(row: AuditRow): AuditLog {
  return {
    id: row.id,
    deviceId: row.deviceId,
    actor: row.actor,
    action: row.action,
    detail: row.detail,
    severity: severityOf(row.severity),
    createdAt: row.createdAt.toISOString(),
  };
}

export function toSavedCommand(row: SavedRow): SavedCommand {
  return {
    id: row.id,
    name: row.name,
    command: row.command,
    description: row.description,
    category: row.category,
    createdAt: row.createdAt.toISOString(),
  };
}
