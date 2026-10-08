// POST /api/files/rename — contract alias for POST /api/files { action: "rename" }
import type { NextRequest } from "next/server";
import { handleFileAction } from "@/lib/api-helpers";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  return handleFileAction(req, "rename");
}
