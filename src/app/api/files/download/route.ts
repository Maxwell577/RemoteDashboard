// GET /api/files/download?deviceId=&path= → FsDownload (sync via hub dispatch)
import type { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { asIntOrNull, basename, err, ok, resolveDevice, writeAudit } from "@/lib/api-helpers";
import { dispatchToHub } from "@/lib/hub";
import type { FsDownload } from "@/lib/types";

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

    const fail = async (errorText: string) => {
      await db.fileOperation.create({
        data: {
          deviceId: device.id,
          op: "download",
          path,
          details: errorText,
          status: "failed",
        },
      });
      return err(errorText, 502);
    };

    const res = await dispatchToHub(device.agentId, "fs:download", { path }, { deviceId: device.id });
    if (!res.ok) return fail(res.error);
    const d = (res.data && typeof res.data === "object" ? res.data : null) as Partial<FsDownload> | null;
    if (!d || typeof d.contentBase64 !== "string") {
      return fail("Agent returned an invalid download");
    }

    const sizeBytes = asIntOrNull(d.sizeBytes) ?? Math.max(0, Math.floor((d.contentBase64.length * 3) / 4));
    await db.fileOperation.create({
      data: {
        deviceId: device.id,
        op: "download",
        path,
        details: "downloaded",
        status: "ok",
        sizeBytes,
      },
    });
    await writeAudit({
      deviceId: device.id,
      action: "file.download",
      detail: path,
      severity: "info",
    });
    const download: FsDownload = {
      path: typeof d.path === "string" && d.path !== "" ? d.path : path,
      name: typeof d.name === "string" && d.name !== "" ? d.name : basename(path),
      sizeBytes,
      contentBase64: d.contentBase64,
      ...(typeof d.encryptedNote === "string" ? { encryptedNote: d.encryptedNote } : {}),
    };
    return ok(download);
  } catch (e) {
    console.error("GET /api/files/download failed", e);
    return err("File download failed", 500);
  }
}
