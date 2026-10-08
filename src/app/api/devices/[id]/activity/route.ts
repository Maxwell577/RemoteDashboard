// GET /api/devices/[id]/activity?limit= → DeviceActivityEntry[]
// Unified recent-activity timeline for one device: commands, file
// operations, media captures, network captures, location pings and
// alerts merged into a single reverse-chronological feed.
import type { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { err, intParam, ok, resolveDevice } from "@/lib/api-helpers";
import type { DeviceActivityEntry } from "@/lib/types";

export const dynamic = "force-dynamic";

const PER_TYPE_TAKE = 6;

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const device = await resolveDevice(id);
    if (!device) return err("Device not found", 404);

    const sp = req.nextUrl.searchParams;
    const limit = Math.min(50, intParam(sp, "limit", 14));

    const [commands, files, media, captures, pings, alerts] = await Promise.all([
      db.commandExecution.findMany({
        where: { deviceId: device.id },
        orderBy: { createdAt: "desc" },
        take: PER_TYPE_TAKE,
        select: { id: true, command: true, status: true, exitCode: true, durationMs: true, createdAt: true },
      }),
      db.fileOperation.findMany({
        where: { deviceId: device.id },
        orderBy: { createdAt: "desc" },
        take: PER_TYPE_TAKE,
        select: { id: true, op: true, path: true, status: true, sizeBytes: true, createdAt: true },
      }),
      db.mediaAsset.findMany({
        where: { deviceId: device.id },
        orderBy: { createdAt: "desc" },
        take: PER_TYPE_TAKE,
        select: { id: true, kind: true, status: true, format: true, durationSec: true, createdAt: true },
      }),
      db.networkCapture.findMany({
        where: { deviceId: device.id },
        orderBy: { startedAt: "desc" },
        take: PER_TYPE_TAKE,
        select: { id: true, status: true, iface: true, filterBpf: true, packets: true, bytesCaptured: true, startedAt: true },
      }),
      db.locationPing.findMany({
        where: { deviceId: device.id },
        orderBy: { createdAt: "desc" },
        take: PER_TYPE_TAKE,
        select: { id: true, lat: true, lon: true, label: true, source: true, createdAt: true },
      }),
      db.alert.findMany({
        where: { deviceId: device.id },
        orderBy: { createdAt: "desc" },
        take: PER_TYPE_TAKE,
        select: { id: true, title: true, message: true, severity: true, acknowledged: true, createdAt: true },
      }),
    ]);

    const entries: DeviceActivityEntry[] = [
      ...commands.map((c) => ({
        id: `cmd-${c.id}`,
        type: "command" as const,
        title: c.command.length > 90 ? `${c.command.slice(0, 90)}…` : c.command,
        detail:
          c.status === "completed"
            ? `exit ${c.exitCode ?? 0} · ${c.durationMs ?? 0}ms`
            : c.status,
        status: c.status,
        severity: c.status === "failed" || c.status === "timeout" ? ("warning" as const) : ("info" as const),
        at: c.createdAt.toISOString(),
      })),
      ...files.map((f) => ({
        id: `file-${f.id}`,
        type: "file" as const,
        title: `${f.op} — ${f.path.length > 70 ? `${f.path.slice(0, 70)}…` : f.path}`,
        detail:
          f.sizeBytes != null ? `${f.status} · ${f.sizeBytes.toLocaleString()} bytes` : f.status,
        status: f.status,
        severity: f.status === "failed" ? ("warning" as const) : ("info" as const),
        at: f.createdAt.toISOString(),
      })),
      ...media.map((m) => ({
        id: `media-${m.id}`,
        type: "media" as const,
        title: `${m.kind.replace(/_/g, " ")} capture`,
        detail: [m.status, m.format, m.durationSec ? `${m.durationSec}s` : null]
          .filter(Boolean)
          .join(" · "),
        status: m.status,
        severity: m.status === "failed" ? ("warning" as const) : ("info" as const),
        at: m.createdAt.toISOString(),
      })),
      ...captures.map((c) => ({
        id: `net-${c.id}`,
        type: "network" as const,
        title: `Packet capture on ${c.iface}${c.filterBpf ? ` — ${c.filterBpf}` : ""}`,
        detail: `${c.status} · ${c.packets.toLocaleString()} pkts · ${c.bytesCaptured.toLocaleString()} bytes`,
        status: c.status,
        severity: c.status === "failed" ? ("warning" as const) : ("info" as const),
        at: c.startedAt.toISOString(),
      })),
      ...pings.map((p) => ({
        id: `loc-${p.id}`,
        type: "location" as const,
        title: p.label ?? "Location fix",
        detail: `${p.lat.toFixed(4)}, ${p.lon.toFixed(4)} · ${p.source}`,
        status: "ok",
        severity: "info" as const,
        at: p.createdAt.toISOString(),
      })),
      ...alerts.map((a) => ({
        id: `alert-${a.id}`,
        type: "alert" as const,
        title: a.title,
        detail: a.message,
        status: a.acknowledged ? "acked" : "open",
        severity: a.severity as DeviceActivityEntry["severity"],
        at: a.createdAt.toISOString(),
      })),
    ]
      .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
      .slice(0, limit);

    return ok(entries);
  } catch (e) {
    console.error("GET /api/devices/[id]/activity failed", e);
    return err("Failed to load device activity", 500);
  }
}
