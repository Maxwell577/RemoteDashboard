// Simulated cmd.exe (v0.3 shell selection). Shares the PowerShell helpers for
// network/process/system output but frames everything cmd-native, and adds
// dir / cd / type / echo / ver / taskkill / cls / exit.

import type { ExecContext, ExecResult } from "./exec";
import { ipconfig, netstat, sysinfo, tasklist } from "./exec";
import { rndInt } from "../util";
import { Vfs } from "./vfs";

function fmtCmdDate(iso: string): string {
  const d = new Date(iso);
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
  const date = `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}/${d.getFullYear()}`;
  return `${date}  ${time.padStart(8)}`;
}

function cmdPath(ctx: ExecContext, target: string): string {
  const t = target.replace(/"/g, "").trim();
  if (t === "" || /^[a-zA-Z]:\\?$/i.test(t)) return Vfs.normalize(t || ctx.cwd) ?? ctx.cwd;
  if (t.startsWith("\\") || t.startsWith("/")) {
    return Vfs.normalize(`${ctx.cwd.slice(0, 2)}${t}`) ?? ctx.cwd;
  }
  return Vfs.normalize(`${ctx.cwd}\\${t}`) ?? ctx.cwd;
}

export async function runCommandCmd(command: string, ctx: ExecContext): Promise<ExecResult> {
  const t0 = Date.now();
  const trimmed = (command ?? "").trim();
  const lower = trimmed.toLowerCase();
  const done = (output: string, exitCode = 0): ExecResult => ({
    output,
    exitCode,
    durationMs: Date.now() - t0 + rndInt(20, 120),
    shell: "cmd" as const,
  });

  // cmd.exe chaining: `a && b` / `a & b` run sequentially; && stops on error.
  const segments = trimmed.split(/&&|&/).map((s) => s.trim()).filter(Boolean);
  if (segments.length > 1) {
    let out = "";
    let code = 0;
    for (const seg of segments) {
      const r = await runCommandCmd(seg, ctx);
      if (r.output !== "") out += (out === "" ? "" : "\n") + r.output;
      if (r.exitCode !== 0) {
        code = r.exitCode;
        break;
      }
    }
    return done(out, code);
  }

  const argv = trimmed.length === 0 ? [] : trimmed.split(/\s+/);
  const cmd = (argv[0] ?? "").toLowerCase();
  const argsStr = argv.length > 1 ? trimmed.slice(trimmed.indexOf(" ") + 1).trim() : "";

  switch (cmd) {
    case "":
      return done("");
    case "ver":
      return done(`\nMicrosoft Windows [Version ${ctx.def.osBuild}]`);
    case "hostname":
      return done(ctx.def.info.hostname);
    case "whoami":
      return done(`${ctx.def.info.hostname}\\${ctx.def.userName}`);
    case "echo": {
      const text = argsStr.replace(/^"(.*)"$/, "$1").replace(/^'(.*)"$/, "$1");
      return done(text === "on" || text === "off" ? "" : text.replace(/^\.$/, ""));
    }
    case "cls":
      return done("");
    case "exit":
      return done("");
    case "systeminfo":
      return done(sysinfo(ctx));
    case "ipconfig":
      return done(ipconfig(ctx, lower.includes("/all")));
    case "tasklist":
      return done(tasklist(ctx));
    case "netstat":
      return done(netstat(ctx));
    case "taskkill": {
      const pidMatch = /\/pid\s+(\d+)/i.exec(trimmed);
      if (!pidMatch) {
        return done("ERROR: Invalid syntax. Use: taskkill /pid <pid> [/f]", 1);
      }
      try {
        ctx.procTable.action(parseInt(pidMatch[1], 10), "kill");
        return done("");
      } catch (e) {
        return done(`ERROR: The process "${pidMatch[1]}" not found. ${(e as Error).message}`.trim(), 1);
      }
    }
    case "dir": {
      const target = argsStr.replace(/\/[a-z]+\s*/gi, "").trim();
      const path = target === "" ? ctx.cwd : cmdPath(ctx, target);
      let listing;
      try {
        listing = ctx.vfs.list(path);
      } catch {
        return done("File Not Found", 1);
      }
      const rows = [
        "",
        ` Volume in drive ${listing.path.slice(0, 1)} is ${ctx.def.volumes[0]?.label ?? "OS"}`,
        " Volume Serial Number is 9C4F-A1B2",
        "",
        ` Directory of ${listing.path}`,
        "",
      ];
      const dot = fmtCmdDate(new Date().toISOString());
      rows.push(`${dot}    <DIR>          .`);
      rows.push(`${dot}    <DIR>          ..`);
      let fileCount = 0;
      let fileBytes = 0;
      for (const e of listing.entries) {
        const dt = fmtCmdDate(e.modifiedAt);
        if (e.type === "directory") {
          rows.push(`${dt}    <DIR>          ${e.name}${e.hidden ? " <HIDDEN>" : ""}`);
        } else {
          fileCount++;
          fileBytes += e.sizeBytes;
          rows.push(`${dt}    ${Math.round(e.sizeBytes).toLocaleString("en-US").padStart(14)} ${e.name}${e.hidden ? " <HIDDEN>" : ""}`);
        }
      }
      const vol = ctx.def.volumes[0];
      const freeBytes = Math.round((vol?.sizeGb ?? 100) * (1 - ctx.def.diskPercent / 100) * 1024 ** 3);
      rows.push(
        `${String(fileCount).padStart(16)} File(s) ${fileBytes.toLocaleString("en-US").padStart(14)} bytes`,
        `${String(listing.entries.filter((e) => e.type === "directory").length + 2).padStart(16)} Dir(s) ${freeBytes.toLocaleString("en-US")} bytes free`,
      );
      return done(rows.join("\n"));
    }
    case "cd":
    case "chdir": {
      const raw = argsStr.replace(/^\/d\s+/i, "").replace(/"/g, "").trim();
      if (raw === "") return done(ctx.cwd);
      const target = raw === ".." ? Vfs.normalize(`${ctx.cwd}\\..`) ?? ctx.cwd.slice(0, 3) : cmdPath(ctx, raw);
      try {
        ctx.vfs.list(target);
      } catch {
        return done("The system cannot find the path specified.", 1);
      }
      ctx.cwd = target;
      return done("");
    }
    case "type": {
      const path = cmdPath(ctx, argsStr);
      try {
        const dl = ctx.vfs.download(path);
        const text = Buffer.from(dl.contentBase64, "base64").toString("utf8");
        return done(text.replace(/[^\x09\x0A\x0D\x20-\x7E]/g, "").split("\n").slice(0, 200).join("\n"));
      } catch {
        return done("The system cannot find the file specified.", 1);
      }
    }
    case "help":
      return done(
        [
          "",
          "Simulated cmd.exe session — available commands:",
          "",
          "  dir [path], cd [/d] [path], type <file>, echo <text>, ver, whoami, hostname,",
          "  ipconfig [/all], tasklist, taskkill /pid <pid> [/f], netstat [-an], systeminfo,",
          "  cls, exit",
          "",
        ].join("\n"),
      );
    default:
      return done(
        `'${argv[0]}' is not recognized as an internal or external command,\noperable program or batch file.`,
        1,
      );
  }
}
