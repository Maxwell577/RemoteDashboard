// POST /api/internal/devices/register  (hub → api, x-hub-token)
// body: AgentInfo → Device (upsert by agentId; alert on first enrollment)
import type { NextRequest } from "next/server";
import { db } from "@/lib/db";
import {
  asIntOr,
  asStringOrNull,
  err,
  getAppSettings,
  ok,
  readBody,
  verifyHubToken,
  writeAudit,
} from "@/lib/api-helpers";
import { toDevice } from "@/lib/serialize";

export const dynamic = "force-dynamic";

const DEVICE_TYPES = ["workstation", "laptop", "server"] as const;

export async function POST(req: NextRequest) {
  try {
    if (!verifyHubToken(req)) return err("Unauthorized", 401);
    const body = await readBody<Record<string, unknown>>(req);
    if (!body) return err("Invalid JSON body", 400);
    const agentId = typeof body.agentId === "string" ? body.agentId : "";
    const hostname = typeof body.hostname === "string" ? body.hostname : "";
    if (!agentId || !hostname) return err("agentId and hostname are required", 400);

    const deviceType = (DEVICE_TYPES as readonly string[]).includes(String(body.deviceType))
      ? (String(body.deviceType) as (typeof DEVICE_TYPES)[number])
      : "workstation";
    const publicIp = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || null;

    const base = {
      hostname,
      osName: asStringOrNull(body.osName) ?? "Windows",
      osVersion: asStringOrNull(body.osVersion) ?? "",
      osArch: asStringOrNull(body.osArch) ?? "",
      platform: asStringOrNull(body.platform) ?? "win32",
      cpuModel: asStringOrNull(body.cpuModel),
      cpuCores: asIntOr(body.cpuCores, 0),
      totalMemoryMB: asIntOr(body.totalMemoryMB, 0),
      localIp: asStringOrNull(body.localIp),
      macAddress: asStringOrNull(body.macAddress),
      agentVersion: asStringOrNull(body.agentVersion),
      deviceType,
      status: "online",
      lastSeen: new Date(),
    };

    const existing = await db.device.findUnique({ where: { agentId } });
    const device = existing
      ? await db.device.update({
          where: { agentId },
          data: {
            ...base,
            ...(typeof body.friendlyName === "string" ? { friendlyName: body.friendlyName } : {}),
            ...(Array.isArray(body.tags)
              ? { tags: JSON.stringify(body.tags.map((t) => String(t))) }
              : {}),
            ...(publicIp ? { ipAddress: publicIp } : {}),
          },
        })
      : await db.device.create({
          data: {
            agentId,
            ...base,
            friendlyName: typeof body.friendlyName === "string" ? body.friendlyName : null,
            tags: JSON.stringify(Array.isArray(body.tags) ? body.tags.map((t) => String(t)) : []),
            ipAddress: publicIp,
          },
        });

    if (!existing) {
      const settings = await getAppSettings();
      if (settings.alertsOnNewDevice) {
        await db.alert.create({
          data: {
            deviceId: device.id,
            title: "New device enrolled",
            message: `${hostname} (${base.osName}) enrolled via hub${publicIp ? ` from ${publicIp}` : ""}`,
            severity: "info",
          },
        });
      }
    }
    await writeAudit({
      deviceId: device.id,
      action: existing ? "device.reregistered" : "device.enrolled",
      detail: `${hostname} · ${base.osName} · agent ${base.agentVersion ?? "unknown"}`,
      severity: "info",
      actor: "hub",
    });
    return ok(toDevice(device));
  } catch (e) {
    console.error("POST /api/internal/devices/register failed", e);
    return err("Device registration failed", 500);
  }
}
