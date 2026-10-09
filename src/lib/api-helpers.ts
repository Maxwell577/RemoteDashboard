// SentraRMM — shared API helpers: response envelope, body parsing,
// device resolution, audit writing, hub-token auth, settings access.
// Also hosts the shared domain handlers reused by contract alias routes
// (/api/files/upload etc. → same logic as POST /api/files with `action`).
import { NextResponse, type NextRequest } from "next/server";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { dispatchToHub } from "@/lib/hub";
import {
  DEFAULT_SETTINGS,
  type AppSettings,
  type DeviceMetrics,
  type MediaAsset,
  type NetworkCapture,
  type ProcessInfo,
} from "@/lib/types";
import { toCapture, toMedia } from "@/lib/serialize";

// ───────────────────────── response envelope ───────────────────────

export function ok<T>(data: T, status = 200): NextResponse {
  return NextResponse.json({ ok: true, data }, { status });
}

export function err(error: string, status = 500): NextResponse {
  return NextResponse.json({ ok: false, error }, { status });
}

// ─────────────────────────── request utils ─────────────────────────

export async function readBody<T>(req: NextRequest): Promise<T | null> {
  try {
    return (await req.json()) as T;
  } catch {
    return null;
  }
}

export function intParam(sp: URLSearchParams, key: string, fallback: number): number {
  const raw = sp.get(key);
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Resolve a device by DB id OR agentId (both accepted by the contract). */
export async function resolveDevice(idOrAgentId: string) {
  const byId = await db.device.findUnique({ where: { id: idOrAgentId } });
  if (byId) return byId;
  return db.device.findUnique({ where: { agentId: idOrAgentId } });
}

// ──────────────────────────── audit log ────────────────────────────

export type Severity = "info" | "warning" | "critical";
const SEVERITIES: readonly Severity[] = ["info", "warning", "critical"];

export function coerceSeverity(value: unknown, fallback: Severity = "info"): Severity {
  return typeof value === "string" && (SEVERITIES as readonly string[]).includes(value)
    ? (value as Severity)
    : fallback;
}

/** Audit writes must never break the request that triggered them. */
export async function writeAudit(entry: {
  deviceId?: string | null;
  action: string;
  detail?: string | null;
  severity?: Severity;
  actor?: string;
}): Promise<void> {
  try {
    await db.auditLog.create({
      data: {
        deviceId: entry.deviceId ?? null,
        action: entry.action,
        detail: entry.detail ?? null,
        severity: entry.severity ?? "info",
        actor: entry.actor ?? "admin",
      },
    });
  } catch {
    // non-fatal
  }
}

// ───────────────────────── hub-token auth ──────────────────────────

const DEFAULT_HUB_TOKEN = "sentra-dev-token";

/** Validate x-hub-token: accept the default token when HUB_TOKEN env is unset. */
export function verifyHubToken(req: NextRequest): boolean {
  const token = req.headers.get("x-hub-token") ?? "";
  const expected = process.env.HUB_TOKEN?.trim() || DEFAULT_HUB_TOKEN;
  return token.length > 0 && token === expected;
}

// ─────────────────────────── device liveness ───────────────────────

/** A device counts as online only if marked online AND seen within 45s. */
export function isEffectivelyOnline(
  status: string,
  lastSeen: Date | string | null | undefined,
  now = Date.now(),
): boolean {
  if (status !== "online" || !lastSeen) return false;
  const t = lastSeen instanceof Date ? lastSeen.getTime() : new Date(lastSeen).getTime();
  return Number.isFinite(t) && now - t < 45_000;
}

// ─────────────────────────── settings blob ─────────────────────────

export async function getAppSettings(): Promise<AppSettings> {
  try {
    const row = await db.setting.findUnique({ where: { key: "app" } });
    if (!row) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(row.value) as Partial<AppSettings>;
    return { ...DEFAULT_SETTINGS, ...parsed };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

// ───────────────────────── value coercions ─────────────────────────

export function asStringOrNull(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

export function asIntOrNull(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return Math.round(v);
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) {
    return Math.round(Number(v));
  }
  return null;
}

export function asIntOr(v: unknown, fallback: number): number {
  return asIntOrNull(v) ?? fallback;
}

// ────────────────────── shared: file operations ────────────────────

const FILE_ACTIONS = ["upload", "delete", "rename", "mkdir"] as const;
type FileAction = (typeof FILE_ACTIONS)[number];

/**
 * POST /api/files (body.action) and contract aliases /api/files/{upload,delete,rename,mkdir}.
 * Dispatches to the agent via the hub, records a FileOperation row, audits.
 */
export async function handleFileAction(
  req: NextRequest,
  forcedAction?: (typeof FILE_ACTIONS)[number],
): Promise<NextResponse> {
  try {
    const body = await readBody<{
      action?: string;
      deviceId?: string;
      path?: string;
      name?: string;
      contentBase64?: string;
      newName?: string;
    }>(req);
    if (!body) return err("Invalid JSON body", 400);

    const action = (forcedAction ?? body.action) as FileAction | undefined;
    if (!action || !(FILE_ACTIONS as readonly string[]).includes(action)) {
      return err(`action must be one of: ${FILE_ACTIONS.join(", ")}`, 400);
    }
    const { deviceId, path } = body;
    if (!deviceId || typeof deviceId !== "string") return err("deviceId is required", 400);
    if (!path || typeof path !== "string") return err("path is required", 400);
    const device = await resolveDevice(deviceId);
    if (!device) return err("Device not found", 404);

    let type: string;
    let payload: Record<string, unknown>;
    let details: string | null = path;
    let sizeBytes: number | null = null;

    switch (action) {
      case "upload": {
        const { name, contentBase64 } = body;
        if (!name || typeof contentBase64 !== "string") {
          return err("name and contentBase64 are required for upload", 400);
        }
        type = "fs:upload";
        payload = { path, name, contentBase64 };
        details = `${path}\\${name}`;
        sizeBytes = Math.max(0, Math.floor((contentBase64.length * 3) / 4));
        break;
      }
      case "delete":
        type = "fs:delete";
        payload = { path };
        break;
      case "rename": {
        const { newName } = body;
        if (!newName || typeof newName !== "string") {
          return err("newName is required for rename", 400);
        }
        type = "fs:rename";
        payload = { path, newName };
        details = `${path} → ${newName}`;
        break;
      }
      case "mkdir":
        type = "fs:mkdir";
        payload = { path };
        break;
      default:
        return err("Unsupported action", 400);
    }

    const res = await dispatchToHub(device.agentId, type, payload, { deviceId: device.id });
    const succeeded = res.ok;
    await writeAudit({
      deviceId: device.id,
      action: `file.${action}`,
      detail: succeeded ? details : `failed: ${res.error}`,
      severity: action === "delete" ? "warning" : "info",
    });
    await db.fileOperation.create({
      data: {
        deviceId: device.id,
        op: action,
        path,
        details: succeeded ? details : res.error,
        status: succeeded ? "ok" : "failed",
        sizeBytes,
      },
    });
    if (!succeeded) return err(res.error, 502);
    const data = res.data && typeof res.data === "object" ? res.data : { ok: true };
    return ok(data);
  } catch (e) {
    console.error("file action failed", e);
    return err("File operation failed", 500);
  }
}

// ────────────────────── shared: process actions ────────────────────

const PROCESS_ACTIONS = ["kill", "suspend", "resume"] as const;

/** POST /api/processes (body) and contract alias /api/processes/action. */
export async function handleProcessAction(req: NextRequest): Promise<NextResponse> {
  try {
    const body = await readBody<{ deviceId?: string; pid?: unknown; action?: string }>(req);
    const pid = asIntOrNull(body?.pid);
    if (!body?.deviceId || pid === null || !body.action) {
      return err("deviceId, pid (number) and action are required", 400);
    }
    if (!(PROCESS_ACTIONS as readonly string[]).includes(body.action)) {
      return err(`action must be one of: ${PROCESS_ACTIONS.join(", ")}`, 400);
    }
    const device = await resolveDevice(body.deviceId);
    if (!device) return err("Device not found", 404);

    const res = await dispatchToHub(device.agentId, "ps:action", { pid, action: body.action }, {
      deviceId: device.id,
    });
    if (!res.ok) return err(res.error, 502);
    await writeAudit({
      deviceId: device.id,
      action: `process.${body.action}`,
      detail: `pid ${pid}`,
      severity: body.action === "kill" ? "warning" : "info",
    });
    const data = res.data && typeof res.data === "object" ? res.data : { ok: true };
    return ok(data);
  } catch (e) {
    console.error("process action failed", e);
    return err("Process action failed", 500);
  }
}

// ────────────────────── shared: media recording ────────────────────

export const MEDIA_KINDS = ["screenshot", "screen_record", "mic_record", "camera_stream", "call"] as const;

/** POST /api/media (body) and contract alias /api/media/record. */
export async function handleMediaRecord(req: NextRequest): Promise<NextResponse> {
  try {
    const body = await readBody<{
      deviceId?: string;
      kind?: string;
      quality?: string;
      durationSec?: unknown;
      withMic?: boolean;
    }>(req);
    if (!body?.deviceId) return err("deviceId is required", 400);
    if (!body.kind || !(MEDIA_KINDS as readonly string[]).includes(body.kind)) {
      return err(`kind must be one of: ${MEDIA_KINDS.join(", ")}`, 400);
    }
    const device = await resolveDevice(body.deviceId);
    if (!device) return err("Device not found", 404);

    const kind = body.kind;
    const quality = asStringOrNull(body.quality);
    const withMic = body.withMic === true;
    // 0 / null → indefinite recording
    const durationSec = body.durationSec === null ? null : asIntOrNull(body.durationSec);

    const asset = await db.mediaAsset.create({
      data: { deviceId: device.id, kind, quality, withMic, durationSec, status: "requested" },
    });
    await writeAudit({
      deviceId: device.id,
      action: "media.record",
      detail: `${kind}${quality ? ` ${quality}` : ""} · ${durationSec ? `${durationSec}s` : "indefinite"}${withMic ? " · mic" : ""}`,
      severity: "info",
    });

    const res = await dispatchToHub(
      device.agentId,
      "media:record",
      { assetId: asset.id, kind, quality, durationSec, withMic },
      { assetId: asset.id, deviceId: device.id },
    );
    const updated: MediaAsset = res.ok
      ? toMedia(
          await db.mediaAsset.update({ where: { id: asset.id }, data: { status: "capturing" } }),
        )
      : toMedia(
          await db.mediaAsset.update({
            where: { id: asset.id },
            data: { status: "failed", error: res.error, completedAt: new Date() },
          }),
        );
    return ok(updated);
  } catch (e) {
    console.error("media record failed", e);
    return err("Failed to start recording", 500);
  }
}

// ────────────────────── shared: network capture ────────────────────

/** POST /api/network (body) and contract alias /api/network/start. */
export async function handleNetworkStart(req: NextRequest): Promise<NextResponse> {
  try {
    const body = await readBody<{ deviceId?: string; iface?: string; filterBpf?: string }>(req);
    if (!body?.deviceId) return err("deviceId is required", 400);
    const device = await resolveDevice(body.deviceId);
    if (!device) return err("Device not found", 404);

    const iface = asStringOrNull(body.iface) ?? "any";
    const filterBpf = asStringOrNull(body.filterBpf);

    const capture = await db.networkCapture.create({
      data: { deviceId: device.id, iface, filterBpf, status: "running", startedAt: new Date() },
    });

    const res = await dispatchToHub(
      device.agentId,
      "net:start",
      { captureId: capture.id, iface, filterBpf },
      { captureId: capture.id, deviceId: device.id },
    );
    if (!res.ok) {
      await db.networkCapture.update({
        where: { id: capture.id },
        data: { status: "failed", stoppedAt: new Date() },
      });
      await writeAudit({
        deviceId: device.id,
        action: "network.capture.start",
        detail: `${iface} · failed: ${res.error}`,
        severity: "warning",
      });
      return err(res.error, 502);
    }
    await writeAudit({
      deviceId: device.id,
      action: "network.capture.start",
      detail: `${iface}${filterBpf ? ` · filter: ${filterBpf}` : ""}`,
      severity: "warning",
    });
    const payload: NetworkCapture = toCapture(capture);
    return ok(payload);
  } catch (e) {
    console.error("network start failed", e);
    return err("Failed to start capture", 500);
  }
}

// ────────────────────── shared: metrics fallback ───────────────────

export function coerceMetrics(raw: unknown, deviceId: string): DeviceMetrics {
  const m = (raw && typeof raw === "object" ? raw : {}) as Partial<DeviceMetrics>;
  return {
    // Always normalize to the DB device id — agents may key by agentId.
    deviceId,
    cpuPercent: asIntOr(m.cpuPercent, 0),
    memoryPercent: asIntOr(m.memoryPercent, 0),
    diskPercent: asIntOr(m.diskPercent, 0),
    uptimeSec: asIntOr(m.uptimeSec, 0),
    activeUsers: asIntOr(m.activeUsers, 0),
    netUpKBps: asIntOr(m.netUpKBps, 0),
    netDownKBps: asIntOr(m.netDownKBps, 0),
    capturedAt: typeof m.capturedAt === "string" ? m.capturedAt : new Date().toISOString(),
  };
}

export function coerceProcessList(raw: unknown): ProcessInfo[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (p): p is ProcessInfo =>
      !!p && typeof p === "object" && typeof (p as ProcessInfo).pid === "number",
  );
}

// ───────────────────────── prisma niceties ─────────────────────────

export function isNotFound(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2025";
}

export function basename(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : p;
}
