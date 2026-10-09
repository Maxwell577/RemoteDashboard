// POST /api/network/start — contract alias for POST /api/network
import type { NextRequest } from "next/server";
import { handleNetworkStart } from "@/lib/api-helpers";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  return handleNetworkStart(req);
}
