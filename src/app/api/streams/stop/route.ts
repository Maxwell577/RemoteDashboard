// POST /api/streams/stop  body: { streamId, agentId? }
// → { ok, frames } — dispatches the v0.3 "stream:stop" agent request.
// agentId is resolved from the hub's active-stream registry when omitted.
import type { NextRequest } from "next/server";
import { err, ok, readBody, writeAudit } from "@/lib/api-helpers";
import { dispatchToHub, resolveHubUrl } from "@/lib/hub";

export const dynamic = "force-dynamic";

async function resolveAgentForStream(
  streamId: string,
  agentIdHint: string | null,
): Promise<{ agentId: string | null; kind: string | null }> {
  if (agentIdHint) return { agentId: agentIdHint, kind: null };
  try {
    const hubUrl = await resolveHubUrl();
    const res = await fetch(`${hubUrl.replace(/\/+$/, "")}/agents`, {
      signal: AbortSignal.timeout(2500),
      cache: "no-store",
    });
    if (!res.ok) return { agentId: null, kind: null };
    const json = (await res.json()) as { activeStreams?: { streamId?: unknown; agentId?: unknown; kind?: unknown }[] };
    const found = (json.activeStreams ?? []).find((s) => s && s.streamId === streamId);
    if (found && typeof found.agentId === "string") {
      return { agentId: found.agentId, kind: typeof found.kind === "string" ? found.kind : null };
    }
  } catch {
    // hub unreachable — fall through
  }
  return { agentId: null, kind: null };
}

export async function POST(req: NextRequest) {
  try {
    const body = await readBody<{ streamId?: string; agentId?: string }>(req);
    if (!body?.streamId) return err("streamId is required", 400);
    const streamId = body.streamId;
    const agentIdHint = typeof body.agentId === "string" && body.agentId !== "" ? body.agentId : null;

    const { agentId, kind } = await resolveAgentForStream(streamId, agentIdHint);
    if (!agentId) return err("Unknown streamId — pass agentId or keep the hub registry entry alive", 404);

    const res = await dispatchToHub<{ frames?: unknown }>(
      agentId,
      "stream:stop",
      { streamId },
      { streamId },
      10_000,
    );
    const frames = res.ok && typeof res.data?.frames === "number" ? res.data.frames : null;
    await writeAudit({
      action: "stream.stop",
      detail: `streamId=${streamId}${kind ? ` · ${kind}` : ""} · agent=${agentId} · ${res.ok ? `stopped after ${frames ?? "?"} frames` : `failed: ${res.error}`}`,
      severity: res.ok ? "info" : "warning",
    });
    if (!res.ok) return err(res.error, 502);
    return ok({ ok: true, streamId, frames: frames ?? 0 });
  } catch (e) {
    console.error("POST /api/streams/stop failed", e);
    return err("Failed to stop stream", 500);
  }
}
