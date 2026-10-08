// Simulated PowerShell. Produces realistic multi-line output per device
// (hostname, LAN IP, MAC-derived link-local, hardware, virtual FS for `dir`).

import type { Vfs } from "./vfs";
import type { ProcTable } from "./proc";
import type { DeviceDef } from "./devices";
import { pick, rndInt, sleep } from "../util";

export interface ExecContext {
  def: DeviceDef;
  procTable: ProcTable;
  vfs: Vfs;
  uptimeSec: number;
  cpuPercent: number;
  memPercent: number;
}

export interface ExecResult {
  output: string;
  exitCode: number;
  durationMs: number;
}

// ── small text helpers ───────────────────────────────────────────────────
const w = (s: string, n: number): string => (s.length > n ? s.slice(0, n) : s.padEnd(n));
const wl = (s: string, n: number): string => (s.length > n ? s : s.padStart(n));
const num = (n: number): string => Math.round(n).toLocaleString("en-US");

function fmtLong(d: Date): string {
  return d.toLocaleString("en-US", {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });
}

function fmtDirDate(d: Date): string {
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true });
  return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()} ${time}`;
}

/** EUI-64 style link-local IPv6 derived from the device MAC. */
function linkLocal(mac: string): string {
  const hex = mac.replace(/:/g, "").toLowerCase();
  const first = (parseInt(hex.slice(0, 2), 16) ^ 0x02).toString(16).padStart(2, "0");
  return `fe80::${first}${hex.slice(2, 4)}:${hex.slice(4, 6)}ff:fe${hex.slice(6, 8)}:${hex.slice(8, 10)}${hex.slice(10, 12)}`;
}

function notRecognized(cmd: string): string {
  return `${cmd} : The term '${cmd}' is not recognized as a name of a cmdlet, function, operable program, or script file. Check the spelling of the name, or if a path was included, verify that the path is correct and try again.
At line:1 char:1
+ ${cmd}
+ ~~~~~
    + CategoryInfo          : ObjectNotFound: (${cmd}:String) [], CommandNotFoundException
    + FullyQualifiedErrorId : CommandNotFoundException`;
}

// ── command implementations ──────────────────────────────────────────────

function sysinfo(ctx: ExecContext): string {
  const d = ctx.def;
  const total = d.info.totalMemoryMB;
  const avail = Math.max(1024, Math.round(total * (1 - ctx.memPercent / 100)));
  const boot = fmtLong(new Date(Date.now() - ctx.uptimeSec * 1000));
  const install = fmtLong(new Date(Date.now() - 220 * 86_400_000));
  const lines = [
    `Host Name:                     ${d.info.hostname}`,
    `OS Name:                       ${d.info.osName}`,
    `OS Version:                    ${d.osBuild.split(".").slice(0, 3).join(".")} N/A Build ${d.osBuild.split(".")[2]}`,
    "OS Manufacturer:               Microsoft Corporation",
    `OS Configuration:              ${d.profile === "server" ? "Standalone Server" : "Standalone Workstation"}`,
    "OS Build Type:                 Multiprocessor Free",
    `Registered Owner:              ${d.userName}`,
    "Registered Organization:       Sentra Labs",
    `Product ID:                    00330-80000-00000-AA${rndInt(100, 999)}`,
    `Original Install Date:         ${install}`,
    `System Boot Time:              ${boot}`,
    `System Manufacturer:           ${d.sysManufacturer}`,
    `System Model:                  ${d.sysModel}`,
    "System Type:                   x64-based PC",
    "Processor(s):                  1 Processor(s) Installed.",
    `                               [01]: Intel64 Family 6 Model ${d.profile === "home" ? 161 : d.profile === "server" ? 128 : 167} Stepping 1 GenuineIntel ~${d.cpuMhz} Mhz`,
    `BIOS Version:                  ${d.biosVersion}`,
    "Windows Directory:             C:\\Windows",
    "System Directory:              C:\\Windows\\system32",
    "Boot Device:                   \\Device\\HarddiskVolume2",
    "System Locale:                 en-us;English (United States)",
    "Input Locale:                  en-us;English (United States)",
    "Time Zone:                     South Africa Standard Time",
    `Total Physical Memory:         ${num(total)} MB`,
    `Available Physical Memory:     ${num(avail)} MB`,
    `Virtual Memory: Max Size:      ${num(total * 2)} MB`,
    `Virtual Memory: Available:     ${num(total * 2 - (total - avail))} MB`,
    `Virtual Memory: In Use:        ${num(total - avail + rndInt(512, 4096))} MB`,
    "Page File Location(s):         C:\\pagefile.sys",
    "Domain:                        WORKGROUP",
    `Logon Server:                  \\\\${d.info.hostname}`,
    "Hotfix(s):                     N/A",
    "Network Card(s):               1 NIC(s) Installed.",
    `                               [01]: ${d.nicDescription}`,
    "                                     Connection Name: Ethernet",
    "                                     DHCP Enabled: Yes",
    "                                     DHCP Server: 192.168.1.1",
    "                                     IP address(es)",
    `                                     [01]: ${d.info.localIp}`,
    `                                     [02]: ${linkLocal(d.info.macAddress)}`,
  ];
  return lines.join("\n");
}

function ipconfig(ctx: ExecContext, showAll: boolean): string {
  const d = ctx.def;
  const mac = d.info.macAddress.replace(/:/g, "-");
  const lines: string[] = ["", "Windows IP Configuration", ""];

  const block = (title: string, ip: string, all: boolean, suffix: string): string[] => {
    if (!all) {
      return [
        `${title}:`, "",
        `   Connection-specific DNS Suffix  . : ${suffix}`,
        `   Link-local IPv6 Address . . . . . : ${linkLocal(d.info.macAddress)}%12`,
        `   IPv4 Address. . . . . . . . . . . : ${ip}`,
        "   Subnet Mask . . . . . . . . . . . : 255.255.255.0",
        `   Default Gateway . . . . . . . . . : ${suffix === "lan" ? "192.168.1.1" : ""}`,
        "",
      ];
    }
    return [
      `${title}:`, "",
      `   Connection-specific DNS Suffix  . : ${suffix}`,
      `   Description . . . . . . . . . . . : ${d.nicDescription}`,
      `   Physical Address. . . . . . . . . : ${mac}`,
      `   DHCP Enabled. . . . . . . . . . . : ${suffix === "lan" ? "Yes" : "No"}`,
      "   Autoconfiguration Enabled . . . . : Yes",
      `   Link-local IPv6 Address . . . . . : ${linkLocal(d.info.macAddress)}%12 (Preferred)`,
      `   IPv4 Address. . . . . . . . . . . : ${ip} (Preferred)`,
      "   Subnet Mask . . . . . . . . . . . : 255.255.255.0",
      ...(suffix === "lan"
        ? [
            `   Lease Obtained. . . . . . . . . . : ${fmtLong(new Date(Date.now() - 3 * 3_600_000))}`,
            `   Lease Expires . . . . . . . . . . : ${fmtLong(new Date(Date.now() + 21 * 3_600_000))}`,
            "   Default Gateway . . . . . . . . . : 192.168.1.1",
            "   DHCP Server . . . . . . . . . . . : 192.168.1.1",
            "   DNS Servers . . . . . . . . . . . : 192.168.1.1",
            "                                       1.1.1.1",
            "   NetBIOS over Tcpip. . . . . . . . : Enabled",
          ]
        : ["   Default Gateway . . . . . . . . . :", "   NetBIOS over Tcpip. . . . . . . . : Disabled"]),
      "",
    ];
  };

  lines.push(...block("Ethernet adapter Ethernet", d.info.localIp, showAll, "lan"));
  if (d.profile === "server") {
    lines.push(...block("Ethernet adapter Lab-Isolated", "10.10.0.5", showAll, "lab.internal"));
  }
  return lines.join("\n").trimEnd();
}

function tasklist(ctx: ExecContext): string {
  const rows = [
    "",
    `${w("Image Name", 25)}${wl("PID", 8)} ${w("Session Name", 16)}${w("Session#", 12)}${wl("Mem Usage", 12)}`,
    `${"=".repeat(25)} ${"=".repeat(8)} ${"=".repeat(16)}${"=".repeat(12)}${"=".repeat(12)}`,
    "System Idle Process              0 Services                   0          8 K",
  ];
  for (const p of ctx.procTable.list()) {
    const memK = Math.max(8, Math.round(p.memoryMB * 1024));
    const svc = p.user === "SYSTEM";
    rows.push(
      `${w(p.name, 25)}${wl(String(p.pid), 8)} ${w(svc ? "Services" : "Console", 16)}${w(svc ? "0" : "1", 12)}${wl(num(memK), 12)} K`,
    );
  }
  return rows.join("\n");
}

function getProcess(ctx: ExecContext): string {
  const rows = [
    "",
    ` ${wl("NPM(K)", 7)}${wl("PM(M)", 10)}${wl("WS(M)", 10)}${wl("CPU(s)", 12)}${wl("Id", 9)}${wl("SI", 4)} ProcessName`,
    ` ${wl("------", 7)}${wl("-----", 10)}${wl("-----", 10)}${wl("------", 12)}${wl("--", 9)}${wl("--", 4)} -----------`,
  ];
  for (const p of ctx.procTable.list()) {
    rows.push(
      ` ${wl(String(rndInt(8, 40)), 7)}${wl((p.memoryMB * 0.82).toFixed(2), 10)}${wl(p.memoryMB.toFixed(2), 10)}${wl((p.cpuPercent * rndInt(20, 220)).toFixed(2), 12)}${wl(String(p.pid), 9)}${wl(p.user === "SYSTEM" ? "0" : "1", 4)} ${p.name.replace(/\.exe$/i, "")}`,
    );
  }
  return rows.join("\n");
}

function getLocation(ctx: ExecContext): string {
  return `Path
----
C:\\Users\\${ctx.def.userName}`;
}

function dir(ctx: ExecContext, target: string | null): { output: string; exitCode: number } {
  const fallback = `C:\\Users\\${ctx.def.userName}`;
  const path = target && /^[a-zA-Z]:/.test(target) ? target : fallback;
  let listing;
  try {
    listing = ctx.vfs.list(path);
  } catch {
    return {
      output: `dir : Cannot find path '${path}' because it does not exist.
At line:1 char:1
+ dir${target ? ` ${target}` : ""}
+ ~~~~~
    + CategoryInfo          : ObjectNotFound: (${path}:String) [Get-ChildItem], ItemNotFoundException
    + FullyQualifiedErrorId : DirIOPathNotFound,Microsoft.PowerShell.Commands.GetChildItemCommand`,
      exitCode: 1,
    };
  }
  const rows = [
    "",
    `    Directory: ${listing.path}`,
    "",
    "Mode                 LastWriteTime         Length Name",
    "----                 -------------         ------ ----",
  ];
  for (const e of listing.entries) {
    const mode = e.type === "directory" ? (e.hidden ? "d--h--" : "d-----") : e.hidden ? "-a-h--" : "-a----";
    const dt = fmtDirDate(new Date(e.modifiedAt));
    const len = e.type === "file" ? num(e.sizeBytes) : "";
    rows.push(`${mode}         ${dt.padStart(18)}${len.padStart(13)} ${e.name}`);
  }
  return { output: rows.join("\n"), exitCode: 0 };
}

function getNetIpAddress(ctx: ExecContext): string {
  const d = ctx.def;
  const block = (ip: string, idx: number, alias: string, family: "IPv4" | "IPv6", prefix: number, origin: string): string[] => [
    "",
    `IPAddress         : ${ip}`,
    `InterfaceIndex    : ${idx}`,
    `InterfaceAlias    : ${alias}`,
    `AddressFamily     : ${family}`,
    "Type              : Unicast",
    `PrefixLength      : ${prefix}`,
    `PrefixOrigin      : ${origin}`,
    `SuffixOrigin      : ${family === "IPv4" ? "Dhcp" : "Link"}`,
    "AddressState      : Preferred",
    ...(family === "IPv4" ? ["ValidLifetime     : 22:59:42", "PreferredLifetime : 22:59:42"] : []),
    "SkipAsSource      : False",
    "PolicyStore       : ActiveStore",
  ];
  const rows: string[] = [];
  rows.push(...block(d.info.localIp, 12, "Ethernet", "IPv4", 24, "Dhcp"));
  rows.push(...block(linkLocal(d.info.macAddress), 12, "Ethernet", "IPv6", 64, "WellKnown"));
  rows.push(...block("127.0.0.1", 1, "Loopback Pseudo-Interface 1", "IPv4", 8, "Manual"));
  if (d.profile === "server") rows.push(...block("10.10.0.5", 18, "Lab-Isolated", "IPv4", 24, "Manual"));
  return rows.join("\n").trimStart();
}

function netstat(ctx: ExecContext): string {
  const d = ctx.def;
  const ip = d.info.localIp;
  const rows = [
    "",
    "Active Connections",
    "",
    "  Proto  Local Address          Foreign Address        State",
  ];
  const listen = (addr: string, port: number): void => {
    rows.push(`  TCP    ${w(`${addr}:${port}`, 22)} ${w("0.0.0.0:0", 22)}LISTENING`);
  };
  listen("0.0.0.0", 135);
  listen("0.0.0.0", 445);
  listen("0.0.0.0", 5357);
  if (d.profile === "server") {
    listen("0.0.0.0", 3389);
    listen("0.0.0.0", 22);
    listen("0.0.0.0", 5985);
  } else {
    listen("0.0.0.0", 139);
    listen("0.0.0.0", 5040);
  }
  listen("[::]", 135);
  listen("[::]", 445);
  // the hub connection itself
  rows.push(`  TCP    ${w("127.0.0.1:3003", 22)} ${w(`127.0.0.1:${rndInt(49152, 65500)}`, 22)}ESTABLISHED`);
  const foreign = ["104.18.32.115", "142.250.72.68", "52.113.194.132", "13.107.42.14", "1.1.1.1", "93.184.216.34", "20.42.65.92", "151.101.1.69"];
  for (let i = 0; i < rndInt(6, 10); i++) {
    rows.push(`  TCP    ${w(`${ip}:${rndInt(49152, 65500)}`, 22)} ${w(`${pick(foreign)}:443`, 22)}ESTABLISHED`);
  }
  rows.push(`  TCP    ${w(`${ip}:${rndInt(49152, 65500)}`, 22)} ${w(`${pick(foreign)}:443`, 22)}TIME_WAIT`);
  rows.push(`  TCP    ${w(`${ip}:${rndInt(49152, 65500)}`, 22)} ${w(`${pick(foreign)}:80`, 22)}TIME_WAIT`);
  rows.push("  UDP    0.0.0.0:5353           *:*");
  rows.push("  UDP    0.0.0.0:68             *:*");
  rows.push("  UDP    [::]:500               *:*");
  return rows.slice(0, 44).join("\n");
}

function getVolume(ctx: ExecContext): string {
  const rows = [
    "",
    `${w("DriveLetter", 12)}${w("FriendlyName", 13)}${w("FileSystemType", 15)}${w("DriveType", 10)}${w("HealthStatus", 13)}${w("OperationalStatus", 18)}${wl("SizeRemaining", 14)}${wl("Size", 10)}`,
    `${"-".repeat(11)} ${"-".repeat(12)} ${"-".repeat(14)} ${"-".repeat(9)} ${"-".repeat(12)} ${"-".repeat(17)}${"-".repeat(14)}${"-".repeat(10)}`,
  ];
  for (const v of ctx.def.volumes) {
    const remaining = v.sizeGb * (1 - ctx.def.diskPercent / 100);
    rows.push(
      `${w(v.letter, 12)}${w(v.label, 13)}${w("NTFS", 15)}${w("Fixed", 10)}${w("Healthy", 13)}${w("OK", 18)}${wl(`${remaining.toFixed(2)} GB`, 14)}${wl(`${v.sizeGb.toFixed(2)} GB`, 10)}`,
    );
  }
  return rows.join("\n");
}

function whoamiPriv(ctx: ExecContext): string {
  const rows: string[][] = ctx.def.profile === "server"
    ? [
        ["SeIncreaseQuotaPrivilege", "Adjust memory quotas for a process", "Enabled"],
        ["SeSecurityPrivilege", "Manage auditing and security log", "Disabled"],
        ["SeTakeOwnershipPrivilege", "Take ownership of files or other objects", "Disabled"],
        ["SeLoadDriverPrivilege", "Load and unload device drivers", "Enabled"],
        ["SeSystemProfilePrivilege", "Profile system performance", "Disabled"],
        ["SeSystemtimePrivilege", "Change the system time", "Disabled"],
        ["SeProfileSingleProcessPrivilege", "Profile single process", "Disabled"],
        ["SeRemoteShutdownPrivilege", "Force shutdown from a remote system", "Disabled"],
        ["SeRestorePrivilege", "Restore files and directories", "Enabled"],
        ["SeBackupPrivilege", "Back up files and directories", "Enabled"],
        ["SeShutdownPrivilege", "Shut down the system", "Disabled"],
        ["SeDebugPrivilege", "Debug programs", "Enabled"],
        ["SeChangeNotifyPrivilege", "Bypass traverse checking", "Enabled"],
        ["SeSystemEnvironmentPrivilege", "Modify firmware environment values", "Disabled"],
        ["SeManageVolumePrivilege", "Perform volume maintenance tasks", "Enabled"],
        ["SeIncreaseWorkingSetPrivilege", "Increase a process working set", "Enabled"],
      ]
    : [
        ["SeShutdownPrivilege", "Shut down the system", "Disabled"],
        ["SeChangeNotifyPrivilege", "Bypass traverse checking", "Enabled"],
        ["SeUndockPrivilege", "Remove computer from docking station", "Disabled"],
        ["SeIncreaseWorkingSetPrivilege", "Increase a process working set", "Enabled"],
        ["SeTimeZonePrivilege", "Change the time zone", "Disabled"],
      ];
  const lines = [
    "",
    "PRIVILEGES INFORMATION",
    "----------------------",
    "",
    "Privilege Name                Description                               State",
    "============================= ========================================= ========",
  ];
  for (const [name, desc, state] of rows) {
    lines.push(`${w(name, 30)}${w(desc, 42)}${state}`);
  }
  return lines.join("\n");
}

function qwinsta(ctx: ExecContext): string {
  const d = ctx.def;
  const rows = [
    "",
    " SESSIONNAME       USERNAME       ID  STATE   TYPE     DEVICE",
    " services                           0  Disc",
  ];
  rows.push(`>console         ${w(d.userName, 14)}  ${w("1", 4)}Active`);
  if (d.profile === "server") rows.push(` rdp-tcp#0       ${w("auditor", 14)}  ${w("2", 4)}Active`);
  rows.push(" rdp-tcp                       65536  Listen");
  return rows.join("\n");
}

// ── dispatcher ───────────────────────────────────────────────────────────

export async function runCommand(command: string, ctx: ExecContext): Promise<ExecResult> {
  const trimmed = (command ?? "").trim();
  const lower = trimmed.toLowerCase();
  const t0 = Date.now();

  let output: string;
  let exitCode = 0;

  const dirCmd = /^(dir|ls|gci)(\s+(.*))?$/.exec(lower);

  if (lower === "sysinfo" || lower === "systeminfo") {
    output = sysinfo(ctx);
  } else if (lower === "hostname") {
    output = ctx.def.info.hostname;
  } else if (lower.startsWith("whoami")) {
    output = lower.includes("/priv")
      ? whoamiPriv(ctx)
      : `${ctx.def.info.hostname.toLowerCase()}\\${ctx.def.userName}`;
  } else if (lower.startsWith("ipconfig")) {
    output = ipconfig(ctx, lower.includes("/all"));
  } else if (lower.startsWith("netstat")) {
    output = netstat(ctx);
  } else if (lower.startsWith("tasklist")) {
    output = tasklist(ctx);
  } else if (lower === "get-process" || lower === "ps" || lower.startsWith("get-process ")) {
    output = getProcess(ctx);
  } else if (lower === "ver" || lower === "cmd /c ver") {
    output = `Microsoft Windows [Version ${ctx.def.osBuild}]`;
  } else if (lower === "get-location" || lower === "pwd" || lower === "gl") {
    output = getLocation(ctx);
  } else if (dirCmd) {
    const target = dirCmd[3] ? dirCmd[3].trim() : null;
    const res = dir(ctx, target && target !== "" && !target.startsWith("/") ? target : null);
    output = res.output;
    exitCode = res.exitCode;
  } else if (lower === "get-netipaddress" || lower === "gip") {
    output = getNetIpAddress(ctx);
  } else if (lower === "get-volume") {
    output = getVolume(ctx);
  } else if (lower === "qwinsta" || lower === "query session") {
    output = qwinsta(ctx);
  } else {
    output = notRecognized(trimmed);
    exitCode = 1;
    await sleep(rndInt(40, 140));
    return { output, exitCode, durationMs: Date.now() - t0 };
  }

  await sleep(rndInt(50, 400));
  return { output, exitCode, durationMs: Date.now() - t0 };
}
