// POST /api/devices/bulk — bulk actions over a set of device ids.
// body: { ids: string[], action: "maintenance" | "addTag" | "removeTag", value?: boolean | string }
// → { updated: number, detail: string }
import type { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { err, ok, readBody, writeAudit } from "@/lib/api-helpers";

export const dynamic = "force-dynamic";

const MAX_IDS = 200;

function parseTags(json: string | null): string[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed) ? parsed.filter((t): t is string => typeof t === "string") : [];
  } catch {
    return [];
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await readBody<{
      ids?: unknown;
      action?: unknown;
      value?: unknown;
    }>(req);

    const ids = Array.isArray(body?.ids)
      ? body.ids.filter((v): v is string => typeof v === "string" && v.trim() !== "")
      : [];
    if (ids.length === 0) return err("ids must be a non-empty array", 400);
    if (ids.length > MAX_IDS) return err(`Too many ids (max ${MAX_IDS})`, 400);
    const action = body?.action;
    if (action !== "maintenance" && action !== "addTag" && action !== "removeTag") {
      return err("action must be maintenance | addTag | removeTag", 400);
    }

    // maintenance: boolean value flips the window for every selected device
    if (action === "maintenance") {
      if (typeof body?.value !== "boolean") return err("maintenance requires a boolean value", 400);
      const on = body.value;
      const res = await db.device.updateMany({
        where: { id: { in: ids } },
        data: { maintenance: on },
      });
      await writeAudit({
        action: on ? "device.maintenance.bulk_on" : "device.maintenance.bulk_off",
        detail: `${res.count} device(s): ${ids.join(", ")}`,
        severity: "info",
      });
      return ok({ updated: res.count, detail: `maintenance ${on ? "opened" : "closed"}` });
    }

    // tag actions: string value (trim, sane length)
    const tag = typeof body?.value === "string" ? body.value.trim() : "";
    if (tag === "") return err("tag actions require a non-empty string value", 400);
    if (tag.length > 40) return err("tag too long (max 40 chars)", 400);

    const devices = await db.device.findMany({
      where: { id: { in: ids } },
      select: { id: true, tags: true },
    });
    let updated = 0;
    for (const d of devices) {
      const current = parseTags(d.tags);
      const next =
        action === "addTag"
          ? current.includes(tag)
            ? current
            : [...current, tag]
          : current.filter((t) => t !== tag);
      if (next.length === current.length && action === "addTag") continue;
      if (next.length === current.length && action === "removeTag") continue;
      await db.device.update({ where: { id: d.id }, data: { tags: JSON.stringify(next) } });
      updated++;
    }
    await writeAudit({
      action: action === "addTag" ? "device.tag.bulk_add" : "device.tag.bulk_remove",
      detail: `tag "${tag}" ${action === "addTag" ? "added to" : "removed from"} ${updated} device(s): ${ids.join(", ")}`,
      severity: "info",
    });
    return ok({ updated, detail: `tag "${tag}" ${action === "addTag" ? "added" : "removed"}` });
  } catch (e) {
    console.error("POST /api/devices/bulk failed", e);
    return err("Bulk action failed", 500);
  }
}
