// POST /api/processes/action — contract alias for POST /api/processes
import type { NextRequest } from "next/server";
import { handleProcessAction } from "@/lib/api-helpers";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  return handleProcessAction(req);
}
