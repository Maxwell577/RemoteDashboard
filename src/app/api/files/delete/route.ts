// POST /api/files/delete — contract alias for POST /api/files { action: "delete" }
import type { NextRequest } from "next/server";
import { handleFileAction } from "@/lib/api-helpers";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  return handleFileAction(req, "delete");
}
