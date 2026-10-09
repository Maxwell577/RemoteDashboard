// GET  /api/files?deviceId=&path=C:\ → FsListing (sync via hub dispatch)
// POST /api/files  body: { action: "upload"|"delete"|"rename"|"mkdir", ... } → op result
// (Contract aliases /api/files/upload|delete|rename|mkdir share the same handler.)
import type { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { err, handleFileAction, ok, resolveDevice, writeAudit } from "@/lib/api-helpers";
import { dispatchToHub } from "@/lib/hub";
import type { FsListing } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams;
    const deviceId = sp.get("deviceId");
    const path = sp.get("path");
    if (!deviceId) return err("deviceId is required", 400);
    if (!path) return err("path is required", 400);
    const device = await resolveDevice(deviceId);
    if (!device) return err("Device not found", 404);

    const res = await dispatchToHub(device.agentId, "fs:list", { path }, { deviceId: device.id });
    if (!res.ok) {
      await db.fileOperation.create({
        data: { deviceId: device.id, op: "list", path, details: res.error, status: "failed" },
      });
      return err(res.error, 502);
    }
    const d = (res.data && typeof res.data === "object" ? res.data : null) as Partial<FsListing> | null;
    if (!d || !Array.isArray(d.entries)) {
      await db.fileOperation.create({
        data: {
          deviceId: device.id,
          op: "list",
          path,
          details: "invalid listing payload",
          status: "failed",
        },
      });
      return err("Agent returned an invalid listing", 502);
    }

    await db.fileOperation.create({
      data: {
        deviceId: device.id,
        op: "list",
        path,
        details: `${d.entries.length} entries`,
        status: "ok",
      },
    });

    await writeAudit({
      deviceId: device.id,
      action: "file.list",
      detail: `${path} · ${d.entries.length} entries`,
      severity: "info",
    });
    const listing: FsListing = {
      path: typeof d.path === "string" ? d.path : path,
      parent: typeof d.parent === "string" ? d.parent : null,
      drives: Array.isArray(d.drives) ? d.drives.filter((x): x is string => typeof x === "string") : [],
      entries: d.entries,
    };
    return ok(listing);
  } catch (e) {
    console.error("GET /api/files failed", e);
    return err("File listing failed", 500);
  }
}

export async function POST(req: NextRequest) {
  return handleFileAction(req);
}
