// GET /api/recordings/[id]/download → streams db/recordings/<recordingId>.enc
// as application/octet-stream (attachment). The file is the SENTRA-REC-1
// encrypted artifact; decryption happens client-side with the user's
// passphrase — the server never sees it.
import fs from "node:fs";
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/lib/db";
import { err, writeAudit } from "@/lib/api-helpers";
import { recordingFilePath } from "../../mapper";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const byId = await db.recordingArtifact.findUnique({ where: { id } });
    const row = byId ?? (await db.recordingArtifact.findUnique({ where: { recordingId: id } }));
    if (!row) return err("Recording not found", 404);

    const filePath = recordingFilePath(row.recordingId);
    if (!fs.existsSync(filePath)) {
      return err("Recording artifact file not found on the server", 404);
    }
    const size = fs.statSync(filePath).size;
    const data = fs.readFileSync(filePath);

    await writeAudit({
      deviceId: row.deviceId,
      action: "recording.download",
      detail: `${row.recordingId}.enc · ${size} bytes · encrypted (AES-256-GCM)`,
      severity: "info",
    });

    return new NextResponse(new Uint8Array(data), {
      status: 200,
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(size),
        "Content-Disposition": `attachment; filename="${row.recordingId}.enc"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    console.error("GET /api/recordings/[id]/download failed", e);
    return err("Failed to download recording", 500);
  }
}
