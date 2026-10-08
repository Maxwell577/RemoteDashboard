// GET /api/devices/[id] → Device (accepts DB id OR agentId).
import type { NextRequest } from "next/server";
import { err, ok, resolveDevice } from "@/lib/api-helpers";
import { toDevice } from "@/lib/serialize";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const row = await resolveDevice(id);
    if (!row) return err("Device not found", 404);
    return ok(toDevice(row));
  } catch (e) {
    console.error("GET /api/devices/[id] failed", e);
    return err("Failed to load device", 500);
  }
}
