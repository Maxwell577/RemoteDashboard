// POST /api/media/record — contract alias for POST /api/media (recording)
import type { NextRequest } from "next/server";
import { handleMediaRecord } from "@/lib/api-helpers";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  return handleMediaRecord(req);
}
