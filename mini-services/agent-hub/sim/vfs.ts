// Per-device in-memory virtual filesystem with Windows-style paths.
// Backs fs:list / fs:download / fs:upload / fs:delete / fs:rename / fs:mkdir
// and the `dir` command of the simulated PowerShell.

import type { FsDownload, FsEntry, FsListing } from "../../../src/lib/types";
import { hashString, nowIso, pseudoBlob, rndInt } from "../util";
import type { DeviceDef } from "./devices";

export interface VNode {
  name: string;
  type: "file" | "directory";
  sizeBytes: number;
  modifiedAt: string;
  hidden: boolean;
  /** Exact bytes for text/uploaded files. */
  content?: Buffer;
  /** Deterministic pseudo-binary content seed. */
  seed?: number;
  /** Magic bytes prefixed to pseudo content (file signature realism). */
  magic?: number[];
}

const EXE = [0x4d, 0x5a, 0x90, 0x00]; // MZ
const OLE = [0xd0, 0xcf, 0x11, 0xe0]; // .msi
const ZIP = [0x50, 0x4b, 0x03, 0x04]; // docx/xlsx/zip
const PNG = [0x89, 0x50, 0x4e, 0x47];
const JPG = [0xff, 0xd8, 0xff, 0xe0];
const ISO = [0x43, 0x44, 0x30, 0x30]; // CD001
const PCAP = [0x0a, 0x0d, 0x0d, 0x0a]; // pcapng

function driveRootOf(p: string): string {
  return `${p.slice(0, 2)}\\`;
}

function parentOf(p: string): string | null {
  if (p.length === 3) return null; // drive root "C:\"
  const idx = p.lastIndexOf("\\");
  return idx <= 2 ? driveRootOf(p) : p.slice(0, idx);
}

function joinPath(dir: string, name: string): string {
  return dir.endsWith("\\") ? dir + name : `${dir}\\${name}`;
}

function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * 86_400_000 - rndInt(0, 86_400_000)).toISOString();
}

export class Vfs {
  /** normalized dir path (e.g. "C:\Users") → children. Drive roots included. */
  private dirs = new Map<string, Map<string, VNode>>();
  readonly drives: string[];

  constructor(drives: string[]) {
    this.drives = drives;
    for (const d of drives) this.dirs.set(d, new Map());
  }

  /** Normalize a user-supplied path to internal form. Accepts /, \, "C:", case mix. */
  static normalize(input: string): string | null {
    const raw = (input ?? "").trim().replace(/\//g, "\\");
    const m = /^([a-zA-Z]):(\\?(.*))?$/.exec(raw);
    if (!m) return null;
    const rest = (m[3] ?? "").replace(/\\+/g, "\\").replace(/^\\+/, "").replace(/\\+$/, "");
    if (rest === "") return `${m[1].toUpperCase()}:\\`;
    return `${m[1].toUpperCase()}:\\${rest}`;
  }

  private findKey(norm: string): string | null {
    if (this.dirs.has(norm)) return norm;
    const lower = norm.toLowerCase();
    for (const key of this.dirs.keys()) {
      if (key.toLowerCase() === lower) return key;
    }
    return null;
  }

  private findNode(norm: string): { dirKey: string; name: string; node: VNode } | null {
    if (norm.length === 3) return null; // drive root
    const dirKey = this.findKey(parentOf(norm)!);
    if (!dirKey) return null;
    const want = norm.slice(dirKey.length + 1);
    for (const [name, node] of this.dirs.get(dirKey)!) {
      if (name.toLowerCase() === want.toLowerCase()) return { dirKey, name, node };
    }
    return null;
  }

  /** Get (or create) a directory map, building missing parents. */
  private ensureDir(norm: string): Map<string, VNode> {
    const existing = this.findKey(norm);
    if (existing) return this.dirs.get(existing)!;
    const parent = parentOf(norm);
    if (!parent) throw new Error(`Invalid directory path: ${norm}`);
    const parentMap = this.ensureDir(parent);
    const name = norm.slice(parent.length === 3 ? 3 : parent.length + 1);
    parentMap.set(name, { name, type: "directory", sizeBytes: 0, modifiedAt: nowIso(), hidden: false });
    this.dirs.set(norm, new Map());
    return this.dirs.get(norm)!;
  }

  // ── agent request handlers ────────────────────────────────────────────

  list(input: string): FsListing {
    const norm = Vfs.normalize(input);
    const key = norm ? this.findKey(norm) : null;
    if (!key) throw new Error(`Path not found: ${input}`);
    const entries: FsEntry[] = [];
    for (const [name, node] of this.dirs.get(key)!) {
      const entry: FsEntry = {
        name,
        path: joinPath(key, name),
        type: node.type,
        sizeBytes: node.type === "file" ? node.sizeBytes : 0,
        modifiedAt: node.modifiedAt,
        hidden: node.hidden,
      };
      if (node.type === "file" && name.includes(".")) {
        entry.ext = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
      }
      entries.push(entry);
    }
    entries.sort((a, b) =>
      a.type === b.type
        ? a.name.toLowerCase().localeCompare(b.name.toLowerCase())
        : a.type === "directory"
          ? -1
          : 1,
    );
    return { path: key, parent: parentOf(key), drives: [...this.drives], entries };
  }

  download(input: string): FsDownload {
    const norm = Vfs.normalize(input);
    if (!norm) throw new Error(`Invalid path: ${input}`);
    if (norm.length === 3) throw new Error(`Cannot download a drive: ${norm}`);
    const found = this.findNode(norm);
    if (!found) throw new Error(`File not found: ${norm}`);
    const { node } = found;
    if (node.type !== "file") throw new Error(`Cannot download a directory: ${norm}`);
    const content =
      node.content ?? pseudoBlob(node.sizeBytes, node.seed ?? hashString(norm), node.magic);
    return {
      path: norm,
      name: node.name,
      sizeBytes: node.sizeBytes,
      contentBase64: content.toString("base64"),
    };
  }

  upload(input: string, name: string, contentBase64: string): { ok: true; path: string } {
    const norm = Vfs.normalize(input);
    if (!norm) throw new Error(`Invalid directory path: ${input}`);
    if (!name || /[\\/:*?"<>|]/.test(name)) throw new Error(`Invalid file name: '${name}'`);
    this.ensureDir(norm);
    const buf = Buffer.from(contentBase64 ?? "", "base64");
    this.dirs.get(norm)!.set(name, {
      name,
      type: "file",
      sizeBytes: buf.length,
      modifiedAt: nowIso(),
      hidden: false,
      content: buf,
    });
    return { ok: true, path: joinPath(norm, name) };
  }

  remove(input: string): { ok: true } {
    const norm = Vfs.normalize(input);
    if (!norm) throw new Error(`Invalid path: ${input}`);
    if (norm.length === 3) throw new Error(`Cannot delete a drive: ${norm}`);
    const found = this.findNode(norm);
    if (!found) throw new Error(`Path not found: ${norm}`);
    if (found.node.type === "directory") {
      const prefix = `${joinPath(found.dirKey, found.name)}\\`.toLowerCase();
      for (const key of [...this.dirs.keys()]) {
        if (key.toLowerCase().startsWith(prefix) || key.toLowerCase() === joinPath(found.dirKey, found.name).toLowerCase()) {
          this.dirs.delete(key);
        }
      }
    }
    this.dirs.get(found.dirKey)!.delete(found.name);
    return { ok: true };
  }

  rename(input: string, newName: string): { ok: true; path: string } {
    const norm = Vfs.normalize(input);
    if (!norm) throw new Error(`Invalid path: ${input}`);
    if (norm.length === 3) throw new Error(`Cannot rename a drive: ${norm}`);
    if (!newName || /[\\/:*?"<>|]/.test(newName)) throw new Error(`Invalid name: '${newName}'`);
    const found = this.findNode(norm);
    if (!found) throw new Error(`Path not found: ${norm}`);
    const map = this.dirs.get(found.dirKey)!;
    const newPath = joinPath(found.dirKey, newName);
    if (found.name === newName) return { ok: true, path: newPath };
    for (const existing of map.keys()) {
      if (existing.toLowerCase() === newName.toLowerCase()) {
        throw new Error(`An item named '${newName}' already exists`);
      }
    }
    map.delete(found.name);
    found.node.name = newName;
    found.node.modifiedAt = nowIso();
    map.set(newName, found.node);
    if (found.node.type === "directory") {
      const oldPath = joinPath(found.dirKey, found.name);
      for (const [k, v] of [...this.dirs]) {
        if (k === oldPath) {
          this.dirs.delete(k);
          this.dirs.set(newPath, v);
        } else if (k.toLowerCase().startsWith(`${oldPath}\\`.toLowerCase())) {
          this.dirs.delete(k);
          this.dirs.set(newPath + k.slice(oldPath.length), v);
        }
      }
    }
    return { ok: true, path: newPath };
  }

  mkdir(input: string): { ok: true; path: string } {
    const norm = Vfs.normalize(input);
    if (!norm) throw new Error(`Invalid path: ${input}`);
    if (norm.length === 3) return { ok: true, path: norm };
    this.ensureDir(norm);
    return { ok: true, path: norm };
  }

  // ── seed helpers (used at boot only) ──────────────────────────────────

  addDir(dir: string, name: string, hidden = false): string {
    const norm = Vfs.normalize(dir);
    if (!norm) throw new Error(`Invalid seed dir: ${dir}`);
    const parent = this.ensureDir(norm);
    const parentKey = this.findKey(norm)!;
    const childPath = joinPath(parentKey, name);
    if (!parent.has(name)) {
      parent.set(name, {
        name,
        type: "directory",
        sizeBytes: 0,
        modifiedAt: daysAgoIso(rndInt(1, 90)),
        hidden,
      });
    }
    if (!this.findKey(childPath)) this.dirs.set(childPath, new Map());
    return childPath;
  }

  addFile(
    dir: string,
    name: string,
    opts: { sizeBytes?: number; text?: string; magic?: number[]; hidden?: boolean; days?: number } = {},
  ): void {
    const norm = Vfs.normalize(dir);
    const key = norm ? this.findKey(norm) : null;
    if (!key) throw new Error(`Seed dir missing: ${dir}`);
    const content = opts.text !== undefined ? Buffer.from(opts.text, "utf8") : undefined;
    this.dirs.get(key)!.set(name, {
      name,
      type: "file",
      sizeBytes: content ? content.length : (opts.sizeBytes ?? 1024),
      modifiedAt: daysAgoIso(opts.days ?? rndInt(1, 90)),
      hidden: opts.hidden ?? false,
      content,
      seed: rndInt(1, 2_147_483_000),
      magic: opts.magic,
    });
  }
}

// ── per-device seed content ──────────────────────────────────────────────

function agentLogText(def: DeviceDef): string {
  const t = (minsAgo: number): string => new Date(Date.now() - minsAgo * 60_000).toISOString();
  return [
    `${t(47)} INFO  agent v1.2.0 starting (pid ${rndInt(2000, 9000)})`,
    `${t(47)} INFO  platform win32-x64 transport=websocket`,
    `${t(46)} INFO  hub reachable at 127.0.0.1:3003`,
    `${t(46)} INFO  registered as ${def.info.agentId}`,
    `${t(44)} INFO  heartbeat ok (cpu=${(def.cpuBase + 1).toFixed(1)}% mem=${def.memBase.toFixed(1)}%)`,
    `${t(29)} INFO  heartbeat ok (cpu=${(def.cpuBase - 2).toFixed(1)}% mem=${(def.memBase + 1).toFixed(1)}%)`,
    `${t(12)} WARN  ntp drift +0.4s (self-corrected)`,
    `${t(2)} INFO  heartbeat ok (cpu=${(def.cpuBase + 3).toFixed(1)}% mem=${def.memBase.toFixed(1)}%)`,
    "",
  ].join("\n");
}

function configJson(def: DeviceDef): string {
  return `${JSON.stringify(
    {
      hubUrl: "http://127.0.0.1:3003",
      agentId: def.info.agentId,
      hostname: def.info.hostname,
      heartbeatSec: 15,
      telemetry: { cpu: true, memory: true, network: true },
      capture: { inMemory: true, encrypt: true, retentionDays: 30 },
    },
    null,
    2,
  )}\n`;
}

const NOTES_TXT = `SentraRMM rollout notes
=======================
- Agent v1.2.0 deployed to every lab machine
- Rotate the artifact capture password monthly
- Q3 findings draft lives on the Desktop
- Ping IT about the VPN split-tunnel exception
- Wireshark profile "sentra-lab" is on the file share
`;

const RUNBOOKS_MD = `# SentraRMM response runbooks

## Suspicious logon
1. Dispatch \`whoami /priv\` and \`netstat -an\` to the device.
2. Compare active sessions with \`qwinsta\`.
3. Capture a screenshot for the incident timeline.
4. If a process looks planted, suspend it before killing.

## Device offline
1. Check the hub socket and last heartbeat.
2. Ping the device on its LAN segment.
3. Escalate to on-call if unreachable for 10 minutes.

## Artifact handling
- Screenshots and recordings stay in memory by default.
- Encrypt anything persisted with the capture password.
`;

const SSH_CONFIG = `Host lab-srv-01
    HostName 192.168.1.10
    User adminlab
    IdentityFile ~/.ssh/id_ed25519
`;

const KNOWN_HOSTS = `192.168.1.10 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIP3rGy6k9ZUq2vTQn1mWxE8sBh7cJ4aL0oXvN5dF2uHy
192.168.1.50 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIF8kQ2mLv7xRc9sTdY4uJ1nWb6eHg0pKqM3iXoZaVfTc
`;

const HOSTS_FILE = `# Copyright (c) 1993-2009 Microsoft Corp.
#
# This is a sample HOSTS file used by Microsoft TCP/IP for Windows.
127.0.0.1       localhost
::1             localhost
192.168.1.10    lab-srv-01
192.168.1.50    workstation-sentra
192.168.1.64    home-desktop
`;

const INSTALLER_LOG = `[2025-11-01 09:12:04] Sentra Agent installer v1.2.0
[2025-11-01 09:12:06] Extracting service binaries...
[2025-11-01 09:12:09] Installing service SentraAgent
[2025-11-01 09:12:11] Service installed. Starting...
[2025-11-01 09:12:13] Agent registered with hub.
`;

const BLUE_TEAM_MD = `# Blue team checklist
- [ ] Baseline process list diffed nightly
- [ ] EDR telemetry forwarding verified
- [ ] Firewall rules reviewed (3389 restricted to VPN range)
- [ ] Backups: D:\\Backups rotated weekly, restore tested monthly
`;

export function seedDeviceFs(def: DeviceDef): Vfs {
  const vfs = new Vfs(def.volumes.map((v) => `${v.letter}:\\`));
  const u = def.userName;
  const userHome = `C:\\Users\\${u}`;

  // ── C:\ root ──
  vfs.addFile("C:\\", "pagefile.sys", { sizeBytes: 12_884_901_888, hidden: true });
  vfs.addFile("C:\\", "swapfile.sys", { sizeBytes: 268_435_456, hidden: true });
  vfs.addDir("C:\\", "$Recycle.Bin", true);
  vfs.addDir("C:\\", "ProgramData");
  vfs.addDir("C:\\", "Program Files");
  vfs.addDir("C:\\", "Users");
  vfs.addDir("C:\\", "Windows");

  // ── ProgramData ──
  vfs.addDir("C:\\ProgramData", "Microsoft");
  vfs.addDir("C:\\ProgramData\\Microsoft", "Windows");
  vfs.addDir("C:\\ProgramData", "Sentra");
  vfs.addFile("C:\\ProgramData\\Sentra", "agent.log", { text: agentLogText(def), days: 0 });
  vfs.addFile("C:\\ProgramData\\Sentra", "config.json", { text: configJson(def), days: 6 });
  vfs.addDir("C:\\ProgramData\\Sentra", "cache");

  // ── Program Files ──
  vfs.addDir("C:\\Program Files", "Sentra Agent");
  vfs.addFile("C:\\Program Files\\Sentra Agent", "sentra-agent.exe", { sizeBytes: 8_412_672, magic: EXE, days: 3 });
  vfs.addFile("C:\\Program Files\\Sentra Agent", "uninstall.exe", { sizeBytes: 1_204_224, magic: EXE, days: 3 });
  vfs.addDir("C:\\Program Files", "Google Chrome");
  vfs.addFile("C:\\Program Files\\Google Chrome", "chrome.exe", { sizeBytes: 4_915_200, magic: EXE });
  vfs.addDir("C:\\Program Files", "dotnet");
  if (def.profile !== "server") {
    vfs.addDir("C:\\Program Files", "Git");
    vfs.addFile("C:\\Program Files\\Git", "git.exe", { sizeBytes: 5_373_952, magic: EXE });
    vfs.addDir("C:\\Program Files", "Microsoft VS Code");
    vfs.addFile("C:\\Program Files\\Microsoft VS Code", "Code.exe", { sizeBytes: 12_632_064, magic: EXE });
  }
  if (def.profile !== "home") {
    vfs.addDir("C:\\Program Files", "Wireshark");
    vfs.addFile("C:\\Program Files\\Wireshark", "Wireshark.exe", { sizeBytes: 2_726_912, magic: EXE });
    vfs.addFile("C:\\Program Files\\Wireshark", "dumpcap.exe", { sizeBytes: 151_552, magic: EXE });
  }

  // ── Users ──
  vfs.addDir("C:\\Users", "Public");
  vfs.addDir("C:\\Users", u);
  vfs.addFile(userHome, "NTUSER.DAT", { sizeBytes: 1_572_864, hidden: true });
  for (const folder of ["Desktop", "Documents", "Downloads", "Pictures"]) {
    vfs.addDir(userHome, folder);
  }
  vfs.addFile(`${userHome}\\Desktop`, "report-q3.docx", { sizeBytes: 48_128, magic: ZIP });
  if (def.profile === "work") {
    vfs.addFile(`${userHome}\\Desktop`, "Incident Response Plan.docx", { sizeBytes: 96_768, magic: ZIP });
  }
  vfs.addFile(`${userHome}\\Documents`, "notes.txt", { text: NOTES_TXT });
  vfs.addFile(`${userHome}\\Documents`, "runbooks.md", { text: RUNBOOKS_MD });
  vfs.addFile(`${userHome}\\Documents`, "asset-inventory.xlsx", { sizeBytes: 21_504, magic: ZIP });
  if (def.profile === "work") {
    vfs.addFile(`${userHome}\\Documents`, "wireless-audit.pcapng", { sizeBytes: 2_458_112, magic: PCAP });
  }
  vfs.addFile(`${userHome}\\Downloads`, "sentra-agent-1.2.0.msi", { sizeBytes: 12_582_912, magic: OLE, days: 3 });
  if (def.profile !== "home") {
    vfs.addFile(`${userHome}\\Downloads`, "nmap-7.95-setup.exe", { sizeBytes: 26_214_400, magic: EXE, days: 12 });
  }
  vfs.addFile(`${userHome}\\Pictures`, "wallpaper.jpg", { sizeBytes: 1_842_176, magic: JPG });
  vfs.addFile(`${userHome}\\Pictures`, "screenshot-2025-11-02.png", { sizeBytes: 812_544, magic: PNG });
  vfs.addDir(userHome, ".ssh", true);
  vfs.addFile(`${userHome}\\.ssh`, "config", { text: SSH_CONFIG });
  vfs.addFile(`${userHome}\\.ssh`, "known_hosts", { text: KNOWN_HOSTS });

  // ── Windows ──
  vfs.addFile("C:\\Windows", "explorer.exe", { sizeBytes: 5_177_536, magic: EXE });
  vfs.addDir("C:\\Windows", "Temp");
  vfs.addFile("C:\\Windows\\Temp", "agent-installer.log", { text: INSTALLER_LOG, days: 20 });
  vfs.addDir("C:\\Windows", "Fonts");
  vfs.addFile("C:\\Windows\\Fonts", "arial.ttf", { sizeBytes: 768_760 });
  vfs.addFile("C:\\Windows\\Fonts", "segoeui.ttf", { sizeBytes: 1_214_504 });
  vfs.addDir("C:\\Windows", "System32");
  for (const [name, size] of [
    ["cmd.exe", 289_792],
    ["conhost.exe", 1_036_288],
    ["powershell.exe", 557_568],
    ["kernel32.dll", 774_144],
    ["ntdll.dll", 2_113_024],
    ["user32.dll", 1_238_016],
    ["ws2_32.dll", 438_272],
    ["Taskmgr.exe", 1_347_584],
  ] as const) {
    vfs.addFile("C:\\Windows\\System32", name, { sizeBytes: size, magic: EXE });
  }
  vfs.addDir("C:\\Windows\\System32", "drivers");
  vfs.addFile("C:\\Windows\\System32\\drivers", "tcpip.sys", { sizeBytes: 2_359_296, magic: EXE });
  vfs.addFile("C:\\Windows\\System32\\drivers", "fltMgr.sys", { sizeBytes: 498_688, magic: EXE });
  vfs.addDir("C:\\Windows\\System32\\drivers", "etc");
  vfs.addFile("C:\\Windows\\System32\\drivers\\etc", "hosts", { text: HOSTS_FILE, days: 60 });

  // ── D:\ (server only) ──
  if (def.profile === "server") {
    vfs.addDir("D:\\", "Backups");
    vfs.addFile("D:\\Backups", "lab-full-2025-11-01.zip", { sizeBytes: 24_117_248, magic: ZIP, days: 21 });
    vfs.addDir("D:\\", "Shares");
    vfs.addFile("D:\\Shares", "scan-results.zip", { sizeBytes: 4_812_800, magic: ZIP, days: 2 });
    vfs.addFile("D:\\Shares", "pentest-report-draft.docx", { sizeBytes: 88_576, magic: ZIP, days: 1 });
    vfs.addFile("D:\\Shares", "blue-team-checklist.md", { text: BLUE_TEAM_MD, days: 4 });
    vfs.addDir("D:\\", "ISOs");
    vfs.addFile("D:\\ISOs", "sentra-lab-tools.iso", { sizeBytes: 36_495_360, magic: ISO, days: 33 });
  }

  return vfs;
}
