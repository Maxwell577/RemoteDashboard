#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// SentraRMM reference agent v0.3.0
//
// A TRANSPARENT remote-management client. It speaks the exact same socket.io
// protocol as the simulated fleet bundled with the SentraRMM hub:
//
//   agent:register { info, captures }          → registers the device
//   agent:heartbeat { agentId, metrics, loc }  → telemetry every N seconds
//   agent:request { requestId, type, payload } → hub-initiated operations
//   agent:reply    { requestId, ok, data }     → operation result
//   agent:event    { name, payload }           → stream:frame / screen:frame
//   record:status / record:chunk / record:manifest (socket acks)
//
// Supported request types (real implementations, no simulation):
//   exec                 — run a shell command (shell: powershell | cmd | auto
//                          on Windows, bash on POSIX; the reply always reports
//                          the effective shell used)
//   ps:list / ps:action  — running processes + kill/suspend/resume
//   fs:list / fs:download / fs:upload / fs:delete / fs:rename / fs:mkdir
//                        — file operations, scoped to --root (default: home)
//   media:screenshot     — real screen capture on Windows (PowerShell + GDI+)
//   screen:live:start|stop — legacy periodic screenshot frames (agent:event)
//   stream:start|stop    — v0.3 multi-source streams; screen only on Windows,
//                          sourceId must be the primary monitor (multi-monitor
//                          needs the Python agent)
//   record:schedule|cancel — v0.3 scheduled screen recording (Windows only):
//                          2 fps screenshots sealed as a SENTRA-REC-1 artifact
//                          (AES-256-GCM, PBKDF2-HMAC-SHA256 200k iterations)
//                          uploaded in ordered, acked record:chunk events; the
//                          upload survives hub disconnects (chunks buffer).
//
// HONEST LIMITATIONS (the agent reports an explicit error, never fakes data):
//   camera/mic streaming, multi-monitor streaming, media:record, net:start/stop
//   and location:fix need the Python agent (agent-python) or a native capture
//   stack that this reference agent does not ship.
//
// This agent is designed to be SEEN: it prints a visible banner, keeps a
// console window, briefly flashes a shell window when remote commands run
// (disable with --hidden-exec), announces scheduled recordings and shows the
// recording activity in its console. It registers itself in the operator's
// device list and the device user can close it at any time.
// ─────────────────────────────────────────────────────────────────────────────

import { io } from "socket.io-client";
import os from "node:os";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import crypto from "node:crypto";

const AGENT_VERSION = "0.3.0";
const IS_WIN = process.platform === "win32";
const MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024;
const EXEC_TIMEOUT_MS = 25_000;

// ── CLI + config file ────────────────────────────────────────────────────
function parseArgs(argv) {
  const out = {};
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--hub") out.hub = next();
    else if (a === "--name" || a === "--friendly-name") out.friendlyName = next();
    else if (a === "--agent-id") out.agentId = next();
    else if (a === "--tags") out.tags = next();
    else if (a === "--interval") out.heartbeatSec = Number(next());
    else if (a === "--root") out.fsRoot = next();
    else if (a === "--type") out.deviceType = next();
    else if (a === "--config") out.configFile = next();
    else if (a === "--hidden-exec") out.hiddenExec = true;
    else if (a === "--print-info") out.printInfo = true;
    else if (a === "--help" || a === "-h") out.help = true;
  }
  return out;
}

function loadConfig(args) {
  let fileCfg = {};
  const cfgPath =
    args.configFile ??
    path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "sentra-agent.config.json");
  try {
    fileCfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  } catch {
    /* no config file — CLI args/env are enough */
  }
  const merged = { ...fileCfg, ...args };
  return {
    hub: merged.hub ?? process.env.SENTRA_HUB ?? "http://127.0.0.1:3003",
    friendlyName: merged.friendlyName ?? process.env.SENTRA_NAME ?? null,
    agentId: merged.agentId ?? process.env.SENTRA_AGENT_ID ?? null,
    tags: String(merged.tags ?? process.env.SENTRA_TAGS ?? "")
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean),
    heartbeatSec: clampNum(Number(merged.heartbeatSec ?? process.env.SENTRA_INTERVAL ?? 15), 5, 300),
    fsRoot: merged.fsRoot ?? os.homedir(),
    deviceType: normalizeDeviceType(merged.deviceType),
    hiddenExec: merged.hiddenExec === true,
    printInfo: merged.printInfo === true,
    help: merged.help === true,
    configFile: args.configFile ?? null,
  };
}

function clampNum(n, min, max) {
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : min;
}

function normalizeDeviceType(v) {
  return v === "laptop" || v === "server" || v === "workstation" ? v : IS_WIN ? "workstation" : process.platform === "darwin" ? "laptop" : "server";
}

const HELP = `
SentraRMM reference agent — transparent remote management client

Usage: node index.mjs [options]

  --hub URL            Hub base url           (default http://127.0.0.1:3003)
  --name NAME          Friendly device name shown in the console
  --agent-id ID        Stable agent id        (default derived from hostname+mac)
  --tags a,b,c         Device tags
  --interval SEC       Heartbeat interval     (default 15, min 5)
  --root PATH          File-manager scope     (default: user home)
  --type T             workstation | laptop | server
  --config FILE        JSON config file       (default ./sentra-agent.config.json)
  --hidden-exec        Do not flash a console window for remote commands
  --print-info         Print the collected device info and exit
  -h, --help           This help
`.trim();

// ── system info ──────────────────────────────────────────────────────────
function firstNonInternalIfaces() {
  const ifaces = os.networkInterfaces();
  for (const list of Object.values(ifaces)) {
    for (const i of list ?? []) {
      if (!i.internal && i.family === "IPv4") return { ip: i.address, mac: i.mac };
    }
  }
  return { ip: "127.0.0.1", mac: "00:00:00:00:00:00" };
}

function readLinuxDistro() {
  try {
    const txt = fs.readFileSync("/etc/os-release", "utf8");
    const m = txt.match(/^PRETTY_NAME="?([^"\n]+)"?/m);
    if (m) return m[1];
  } catch {
    /* not linux or no os-release */
  }
  return null;
}

/** Windows only — friendly edition string via WMI, cached forever, 4s timeout. */
let wmiCaptionCache;
function windowsEdition() {
  if (wmiCaptionCache !== undefined) return Promise.resolve(wmiCaptionCache);
  return new Promise((resolve) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", "(Get-CimInstance Win32_OperatingSystem).Caption"],
      { windowsHide: true, timeout: 4000 },
    );
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    const done = (val) => {
      wmiCaptionCache = val;
      resolve(val);
    };
    child.on("error", () => done(null));
    child.on("close", (code) => done(code === 0 ? out.trim() || null : null));
  });
}

async function buildAgentInfo(cfg) {
  const { ip, mac } = firstNonInternalIfaces();
  const hostname = os.hostname();
  const stableId =
    cfg.agentId ??
    `node-${hostname.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${crypto.createHash("sha1").update(mac).digest("hex").slice(0, 4)}`;

  let osName;
  if (IS_WIN) osName = (await windowsEdition()) ?? "Windows";
  else if (process.platform === "darwin") osName = "macOS";
  else osName = readLinuxDistro() ?? "Linux";

  return {
    agentId: stableId,
    hostname,
    friendlyName: cfg.friendlyName ?? undefined,
    osName,
    osVersion: os.release(),
    osArch: os.arch(),
    platform: os.platform(),
    cpuModel: os.cpus()[0]?.model?.trim() || "Unknown CPU",
    cpuCores: os.cpus().length,
    totalMemoryMB: Math.round(os.totalmem() / (1024 * 1024)),
    localIp: ip,
    macAddress: mac,
    agentVersion: AGENT_VERSION,
    deviceType: cfg.deviceType,
    tags: cfg.tags,
  };
}

// ── metrics sampler ──────────────────────────────────────────────────────
function cpuTimes() {
  return os.cpus().reduce((acc, c) => {
    acc.idle += c.times.idle;
    acc.total += c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq;
    return acc;
  }, { idle: 0, total: 0 });
}

class NetCounter {
  constructor() {
    this.lastBytes = null;
    this.lastTs = 0;
    this.winCache = { rows: null, at: 0 };
  }
  async linuxBytes() {
    const txt = await fsp.readFile("/proc/net/dev", "utf8").catch(() => null);
    if (!txt) return null;
    let rx = 0;
    let tx = 0;
    for (const line of txt.split("\n").slice(2)) {
      const [name, rest] = line.split(":");
      if (!rest || name.trim() === "lo") continue;
      const cols = rest.trim().split(/\s+/);
      rx += Number(cols[0]) || 0;
      tx += Number(cols[8]) || 0;
    }
    return { rx, tx };
  }
  async windowsBytes() {
    if (Date.now() - this.winCache.at < 10_000 && this.winCache.rows) return this.winCache.rows;
    const rows = await new Promise((resolve) => {
      const child = spawn(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "Get-NetAdapterStatistics | ForEach-Object { \"{0} {1} {2}\" -f $_.Name, $_.ReceivedBytes, $_.SentBytes }",
        ],
        { windowsHide: true, timeout: 5000 },
      );
      let out = "";
      child.stdout.on("data", (c) => (out += c));
      child.on("error", () => resolve(null));
      child.on("close", () => {
        let rx = 0;
        let tx = 0;
        for (const line of out.split("\n")) {
          const cols = line.trim().split(/\s+/);
          if (cols.length >= 3) {
            rx += Number(cols[1]) || 0;
            tx += Number(cols[2]) || 0;
          }
        }
        resolve({ rx, tx });
      });
    });
    this.winCache = { rows, at: Date.now() };
    return rows;
  }
  /** KB/s since the previous call (per-heartbeat delta). */
  async rates() {
    const now = Date.now();
    const cur =
      process.platform === "linux" ? await this.linuxBytes() : IS_WIN ? await this.windowsBytes() : null;
    if (!cur) return { up: 0, down: 0 };
    if (!this.lastBytes || now <= this.lastTs) {
      this.lastBytes = cur;
      this.lastTs = now;
      return { up: 0, down: 0 };
    }
    const dt = (now - this.lastTs) / 1000;
    const down = Math.max(0, (cur.rx - this.lastBytes.rx) / 1024 / dt);
    const up = Math.max(0, (cur.tx - this.lastBytes.tx) / 1024 / dt);
    this.lastBytes = cur;
    this.lastTs = now;
    return { up: Math.round(up), down: Math.round(down) };
  }
}

class Metrics {
  constructor() {
    this.net = new NetCounter();
    this.cpuPrev = cpuTimes();
    this.cpuPrevTs = Date.now();
  }
  cpuPercent() {
    const cur = cpuTimes();
    const now = Date.now();
    const dt = Math.max(1, now - this.cpuPrevTs);
    const idle = cur.idle - this.cpuPrev.idle;
    const total = cur.total - this.cpuPrev.total;
    this.cpuPrev = cur;
    this.cpuPrevTs = now;
    if (total <= 0) return 0;
    return round1(Math.min(100, Math.max(0, (1 - idle / total) * 100)));
  }
  memoryPercent() {
    const total = os.totalmem();
    if (!total) return 0;
    return round1(Math.min(100, ((total - os.freemem()) / total) * 100));
  }
  async diskPercent() {
    try {
      const s = await fsp.statfs(os.homedir());
      const total = Number(s.blocks);
      const free = Number(s.bavail);
      if (!total) return 0;
      return round1(Math.min(100, ((total - free) / total) * 100));
    } catch {
      return 0;
    }
  }
  async activeUsers() {
    if (!IS_WIN) {
      try {
        const out = await sh("who", 2000);
        return out.trim() === "" ? 0 : out.trim().split("\n").length;
      } catch {
        return 1;
      }
    }
    return 1; // an interactive Windows session is running this agent
  }
  async snapshot(agentId, uptimeSec) {
    const [disk, users, net] = await Promise.all([this.diskPercent(), this.activeUsers(), this.net.rates()]);
    return {
      deviceId: agentId,
      cpuPercent: this.cpuPercent(),
      memoryPercent: this.memoryPercent(),
      diskPercent: disk,
      uptimeSec,
      activeUsers: users,
      netUpKBps: net.up,
      netDownKBps: net.down,
      capturedAt: new Date().toISOString(),
    };
  }
}

const round1 = (n) => Math.round(n * 10) / 10;

// ── shell helpers ────────────────────────────────────────────────────────
function sh(command, timeoutMs = EXEC_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, { shell: true, windowsHide: true, timeout: timeoutMs });
    let out = "";
    child.stdout.on("data", (c) => {
      if (out.length < MAX_OUTPUT_BYTES) out += c;
    });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`exit ${code}: ${out.trim().slice(0, 200)}`))));
  });
}

/** Run a remote command exactly like the terminal view expects (v0.3 shell selection). */
let powershellAvailable = IS_WIN ? undefined : false;
async function hasPowerShell() {
  if (!IS_WIN) return false;
  if (powershellAvailable !== undefined) return powershellAvailable;
  powershellAvailable = await new Promise((resolve) => {
    const child = spawn("where.exe", ["powershell.exe"], { windowsHide: true, timeout: 4000 });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
  return powershellAvailable;
}

function execCommand(command, shell, hiddenExec) {
  return new Promise((resolve) => {
    const started = Date.now();
    let child;
    let effective;
    if (IS_WIN) {
      effective = shell === "cmd" ? "cmd" : shell === "auto" ? (powershellAvailable ? "powershell" : "cmd") : "powershell";
      child =
        effective === "cmd"
          ? spawn("cmd.exe", ["/d", "/s", "/c", command], {
              // Transparency: the console window is visible on the device by
              // default so users SEE remote activity. --hidden-exec disables it.
              windowsHide: hiddenExec === true,
            })
          : spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command], {
              windowsHide: hiddenExec === true,
            });
    } else {
      effective = "bash"; // POSIX: bash regardless of the requested shell (reported honestly)
      child = spawn("/bin/bash", ["-lc", command]);
    }

    let out = "";
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      try {
        if (IS_WIN) spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true });
        else child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }, EXEC_TIMEOUT_MS);

    child.stdout.on("data", (c) => {
      if (out.length < MAX_OUTPUT_BYTES) out += c;
    });
    child.stderr.on("data", (c) => {
      if (out.length < MAX_OUTPUT_BYTES) out += c;
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ output: out + `\n[spawn error] ${err.message}`, exitCode: 1, durationMs: Date.now() - started, shell: effective });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const text = out
        .toString("utf8")
        .replace(/\r\n/g, "\n")
        .slice(0, MAX_OUTPUT_BYTES);
      resolve({
        output: killed ? text + `\n[timeout after ${EXEC_TIMEOUT_MS / 1000}s — process terminated]` : text,
        exitCode: killed ? 124 : (code ?? 0),
        durationMs: Date.now() - started,
        shell: effective,
      });
    });
  });
}

// ── process listing ──────────────────────────────────────────────────────
async function listProcessesWindows() {
  const out = await sh(
    "powershell.exe -NoProfile -NonInteractive -Command \"Get-Process | Select-Object Id,ProcessName,CPU,WorkingSet64,Path | ConvertTo-Json -Compress -Depth 2\"",
    8000,
  );
  let arr;
  try {
    const parsed = JSON.parse(out);
    arr = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    throw new Error("Could not parse Get-Process output");
  }
  return arr.slice(0, 200).map((p) => ({
    pid: Number(p.Id) || 0,
    name: String(p.ProcessName ?? "unknown"),
    cpuPercent: 0, // Get-Process reports cumulative CPU seconds, not a rate
    memoryMB: Math.round((Number(p.WorkingSet64) || 0) / (1024 * 1024)),
    status: "running",
    user: "",
    path: String(p.Path ?? ""),
  }));
}

async function listProcessesPosix() {
  const out = await sh("ps -eo pid,pcpu,rss,stat,user,comm --no-headers", 5000);
  return out
    .trim()
    .split("\n")
    .filter(Boolean)
    .slice(0, 200)
    .map((line) => {
      const [pid, pcpu, rss, stat, user, comm] = line.trim().split(/\s+/);
      const status = stat?.startsWith("T") ? "stopped" : stat?.startsWith("S") || stat?.startsWith("R") ? "running" : "running";
      return {
        pid: Number(pid) || 0,
        name: path.basename(comm ?? "unknown"),
        cpuPercent: Math.min(100, Number(pcpu) || 0),
        memoryMB: Math.round((Number(rss) || 0) / 1024),
        status,
        user: user ?? "",
        path: comm ?? "",
      };
    });
}

async function processAction(pid, action) {
  if (action === "kill") {
    if (IS_WIN) await sh(`taskkill /PID ${pid} /T /F`, 5000);
    else process.kill(pid, "SIGKILL");
    return { ok: true, action: "kill", pid };
  }
  if (action === "suspend") {
    if (IS_WIN) throw new Error("suspend is not supported on Windows by the reference agent (needs pssuspend)");
    process.kill(pid, "SIGSTOP");
    return { ok: true, action: "suspend", pid };
  }
  if (action === "resume") {
    if (IS_WIN) throw new Error("resume is not supported on Windows by the reference agent (needs pssuspend)");
    process.kill(pid, "SIGCONT");
    return { ok: true, action: "resume", pid };
  }
  throw new Error(`Unknown process action '${action}'`);
}

// ── file operations (scoped to root) ─────────────────────────────────────
class FileScope {
  constructor(root) {
    this.root = path.resolve(root);
    fs.mkdirSync(this.root, { recursive: true });
  }
  /** Resolve a requested path inside the root; throws when it escapes. */
  resolveIn(p) {
    const abs = path.resolve(this.root, String(p ?? "").replace(/^([A-Za-z]:)?[\\/]+/, "/").slice(1) || ".");
    const rel = path.relative(this.root, abs);
    if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error("Path escapes the agent file scope");
    return abs;
  }
  async list(dirPath) {
    const abs = this.resolveIn(dirPath || ".");
    const dirents = await fsp.readdir(abs, { withFileTypes: true });
    const entries = await Promise.all(
      dirents.slice(0, 500).map(async (d) => {
        const full = path.join(abs, d.name);
        let size = 0;
        let mtime = new Date().toISOString();
        try {
          const st = await fsp.stat(full);
          size = Number(st.size);
          mtime = st.mtime.toISOString();
        } catch {
          /* stat raced a delete — report defaults */
        }
        return {
          name: d.name,
          path: path.relative(this.root, full) || ".",
          type: d.isDirectory() ? "directory" : "file",
          sizeBytes: size,
          modifiedAt: mtime,
          hidden: d.name.startsWith("."),
          ext: d.isDirectory() ? undefined : path.extname(d.name).replace(".", "") || undefined,
        };
      }),
    );
    entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "directory" ? -1 : 1));
    const rel = path.relative(this.root, abs);
    return {
      path: rel || ".",
      parent: rel ? path.dirname(rel) === "." ? "." : path.dirname(rel) : null,
      drives: IS_WIN ? await windowsDrives() : ["/"],
      entries,
    };
  }
  async download(p) {
    const abs = this.resolveIn(p);
    const st = await fsp.stat(abs);
    if (!st.isFile()) throw new Error("Not a file");
    if (st.size > MAX_DOWNLOAD_BYTES) throw new Error(`File too large for inline transfer (>${Math.round(MAX_DOWNLOAD_BYTES / 1024 / 1024)}MB)`);
    const buf = await fsp.readFile(abs);
    return {
      path: p,
      name: path.basename(abs),
      sizeBytes: st.size,
      contentBase64: buf.toString("base64"),
      encryptedNote: "transferred over the hub's socket; stored encrypted at rest by the console",
    };
  }
  async upload(dirPath, name, contentBase64) {
    const absDir = this.resolveIn(dirPath || ".");
    const target = path.join(absDir, path.basename(String(name ?? "upload.bin")));
    await fsp.writeFile(target, Buffer.from(String(contentBase64 ?? ""), "base64"));
    return { ok: true, path: path.relative(this.root, target), name: path.basename(target) };
  }
  async remove(p) {
    const abs = this.resolveIn(p);
    const st = await fsp.stat(abs);
    if (abs === this.root) throw new Error("Refusing to delete the file-scope root");
    await fsp.rm(abs, { recursive: true });
    return { ok: true, removed: path.basename(abs) };
  }
  async rename(p, newName) {
    const abs = this.resolveIn(p);
    const target = path.join(path.dirname(abs), path.basename(String(newName ?? "")));
    if (!target.startsWith(this.root)) throw new Error("Path escapes the agent file scope");
    await fsp.rename(abs, target);
    return { ok: true, path: path.relative(this.root, target) };
  }
  async mkdir(p) {
    const abs = this.resolveIn(p);
    await fsp.mkdir(abs, { recursive: true });
    return { ok: true, path: path.relative(this.root, abs) || "." };
  }
}

let driveCache = { at: 0, drives: ["C:\\"] };
async function windowsDrives() {
  if (Date.now() - driveCache.at < 60_000) return driveCache.drives;
  const found = [];
  for (let i = 65; i <= 90; i++) {
    const d = `${String.fromCharCode(i)}:\\`;
    try {
      await fsp.stat(d);
      found.push(d);
    } catch {
      /* drive absent */
    }
  }
  driveCache = { at: Date.now(), drives: found.length ? found : ["C:\\"] };
  return driveCache.drives;
}

// ── screen capture (real on Windows; graceful error elsewhere) ───────────
let shotSeq = 0;
async function captureScreen() {
  if (IS_WIN) {
    const ps = `
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
$b = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.X, $b.Y, 0, 0, $bmp.Size)
$ms = New-Object System.IO.MemoryStream
$bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
[Convert]::ToBase64String($ms.ToArray())`;
    const b64 = (await sh(`powershell.exe -NoProfile -NonInteractive -Command "${ps.replace(/\n/g, "; ").replace(/"/g, '\\"')}"`, 12_000)).trim();
    if (!b64) throw new Error("Screen capture returned no data");
    return { dataUri: `data:image/png;base64,${b64}`, sizeBytes: Math.round((b64.length * 3) / 4) };
  }
  // Non-Windows: try ImageMagick's `import` when an X display exists.
  if (process.env.DISPLAY) {
    try {
      const b64 = (await sh("import -window root png:- | base64 -w0", 8000)).trim();
      if (b64) return { dataUri: `data:image/png;base64,${b64}`, sizeBytes: Math.round((b64.length * 3) / 4) };
    } catch {
      /* fall through to honest error */
    }
  }
  throw new Error("Screen capture is implemented for Windows (GDI+); on this platform no capture backend was found");
}

// ── capture capabilities (v0.3) ──────────────────────────────────────────
// Enumerated once at startup and sent with agent:register (info.captures) so
// the console can plan captures even while the device is offline. Honest
// everywhere: sources this agent cannot capture are simply not listed.
let capturesCache = null;
async function collectCaptures() {
  if (capturesCache) return capturesCache;
  if (!IS_WIN) {
    capturesCache = {
      monitors: [],
      cameras: [],
      mics: [],
      shells: [],
      notes: [
        "exec uses /bin/bash on this platform",
        "monitor/camera/mic enumeration and capture require the Python agent (agent-python)",
      ],
    };
    return capturesCache;
  }
  const raw = [];
  try {
    const out = await sh(
      'powershell.exe -NoProfile -NonInteractive -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Screen]::AllScreens | ForEach-Object { \\"{0}|{1}|{2}|{3}\\" -f $_.Bounds.Width, $_.Bounds.Height, $_.Primary, $_.DeviceName }"',
      6000,
    );
    for (const line of out.trim().split("\n")) {
      const [w, h, primary, device] = line.trim().split("|");
      if (!w || !h) continue;
      raw.push({ width: Number(w) || 0, height: Number(h) || 0, primary: String(primary).trim().toLowerCase() === "true", device: String(device ?? "").trim() });
    }
  } catch {
    /* enumeration failed — the console gets an empty monitor list + note */
  }
  raw.sort((a, b) => Number(b.primary) - Number(a.primary)); // primary display first
  capturesCache = {
    monitors: raw.map((m, i) => ({
      id: `monitor:${i}`,
      name: `Display ${i + 1}${m.primary ? " (primary)" : ""}${m.device ? ` — ${m.device}` : ""}`,
      width: m.width,
      height: m.height,
      primary: m.primary,
    })),
    cameras: [],
    mics: [],
    shells: ["powershell", "cmd"],
    notes: [
      "camera/mic capture requires the Python agent (agent-python)",
      "multi-monitor capture requires the Python agent (agent-python)",
    ],
  };
  return capturesCache;
}

/** Only the primary display (monitor:0 by enumeration convention) streams here. */
function screenStreamAllowed(sourceId) {
  return sourceId === null || sourceId === undefined || sourceId === "" || sourceId === "monitor:0";
}

// ── v0.3 scheduled screen recording (Windows; SENTRA-REC-1 artifact) ─────
// Produces a REAL encrypted artifact: a JSON header line, then per-frame
// records sealed with AES-256-GCM exactly per the frozen contract in
// src/lib/types.ts. Frames accumulate in memory and are uploaded as ordered,
// acked record:chunk events (≤256KB payload each); if the hub is unreachable
// the recording CONTINUES and buffered chunks flush on reconnect.
const RECORD_CHUNK_BYTES = 180 * 1024; // upload chunk size (base64 ≤ 256KB payload)
const RECORD_ARM_DELAY_MS = 3_000;
const RECORD_FRAME_MS = 500; // 2 fps screenshot loop
const RECORD_STATUS_MS = 5_000;
const RECORD_FLUSH_MS = 1_000;

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

class ScreenRecorder {
  constructor(deps) {
    // deps: { socket, agentId, recordingId, durationSec, passphrase, label, sourceId }
    this.deps = deps;
    this.salt = crypto.randomBytes(16);
    this.key = crypto.pbkdf2Sync(deps.passphrase, this.salt, 200_000, 32, "sha256");
    this.aad = crypto.createHash("sha256").update(deps.recordingId).digest().subarray(0, 16);
    this.hash = crypto.createHash("sha256");
    this.totalBytes = 0;
    this.frames = 0;
    this.nextSeq = 0;
    this.pending = [];
    this.pendingBytes = 0;
    this.uploading = false;
    this.shotBusy = false;
    this.state = "armed";
    this.startedAt = 0;
    this.timers = [];
    this.done = false;
  }

  arm() {
    // TRANSPARENCY (contract, non-optional): the armed recording was announced
    // on the console at schedule time; the recording loop below keeps the
    // activity visible in the agent window the whole time.
    this.timers.push(setTimeout(() => this.start(), RECORD_ARM_DELAY_MS));
  }

  start() {
    if (this.state !== "armed") return;
    this.state = "recording";
    this.startedAt = Date.now();
    const d = this.deps;
    const header = Buffer.from(
      `${JSON.stringify({
        magic: "SENTRA-REC-1",
        cipher: "AES-256-GCM",
        kdf: "PBKDF2-HMAC-SHA256",
        iterations: 200000,
        salt: this.salt.toString("base64"),
        agentId: d.agentId,
        ...(d.label ? { label: d.label } : {}),
        durationSec: d.durationSec,
        sources: [d.sourceId],
        startedAt: this.startedAt,
      })}\n`,
      "utf8",
    );
    this.push(header);
    console.log(`[AGENT] recording ${d.recordingId} started — on-device indicator visible (${d.durationSec}s)`);
    void this.status({ state: "recording", startedAt: new Date(this.startedAt).toISOString() });
    this.timers.push(setInterval(() => void this.captureFrame(), RECORD_FRAME_MS));
    this.timers.push(setInterval(() => void this.flush(), RECORD_FLUSH_MS));
    this.timers.push(
      setInterval(() => {
        void this.status({
          state: "recording",
          elapsedSec: Math.round((Date.now() - this.startedAt) / 1000),
          sizeBytes: this.totalBytes,
          frames: this.frames,
        });
      }, RECORD_STATUS_MS),
    );
    this.timers.push(setTimeout(() => void this.finalize("completed"), d.durationSec * 1000));
    void this.flush();
  }

  async captureFrame() {
    if (this.shotBusy || this.state !== "recording") return;
    this.shotBusy = true;
    try {
      const shot = await captureScreen();
      const b64 = String(shot.dataUri).replace(/^data:image\/[a-z+]+;base64,/, "");
      this.addRecord({ t: Date.now(), kind: "screen", sourceId: this.deps.sourceId, mime: "image/png", dataB64: b64 });
    } catch (err) {
      console.error(`[AGENT] recording frame failed: ${err instanceof Error ? err.message : err}`);
    } finally {
      this.shotBusy = false;
    }
  }

  push(buf) {
    this.hash.update(buf);
    this.totalBytes += buf.length;
    this.pending.push(buf);
    this.pendingBytes += buf.length;
  }

  addRecord(obj) {
    const plaintext = Buffer.from(JSON.stringify(obj), "utf8");
    const nonce = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.key, nonce);
    cipher.setAAD(this.aad);
    const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const body = Buffer.concat([nonce, ct, cipher.getAuthTag()]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(body.length, 0);
    this.push(Buffer.concat([len, body]));
    this.frames += 1;
  }

  async flush(force = false) {
    if (this.uploading || this.state === "armed" || this.done) return;
    if (this.pending.length === 0) return;
    this.uploading = true;
    try {
      while (this.pending.length > 0 && (force || this.pendingBytes >= RECORD_CHUNK_BYTES)) {
        const ok = await this.sendNextChunk();
        if (!ok) return;
      }
    } finally {
      this.uploading = false;
    }
  }

  async sendNextChunk() {
    const parts = [];
    let size = 0;
    while (this.pending.length > 0 && size < RECORD_CHUNK_BYTES) {
      const b = this.pending.shift();
      parts.push(b);
      size += b.length;
    }
    const chunk = Buffer.concat(parts);
    const seq = this.nextSeq;
    for (let attempt = 1; attempt <= 3; attempt++) {
      if (!this.deps.socket.connected) break;
      try {
        const ack = await this.deps.socket.timeout(8000).emitWithAck("record:chunk", {
          recordingId: this.deps.recordingId,
          seq,
          dataB64: chunk.toString("base64"),
        });
        if (ack?.ok) {
          this.nextSeq += 1;
          this.pendingBytes -= size;
          return true;
        }
        console.error(`[AGENT] record:chunk seq=${seq} rejected: ${ack?.error ?? "unknown"}`);
      } catch {
        /* ack timeout / transport error — retry */
      }
      await sleepMs(400);
    }
    this.pending.unshift(chunk); // stays buffered; retried on reconnect/next flush
    return false;
  }

  async status(fields, attempts = 2) {
    for (let i = 0; i < attempts; i++) {
      if (!this.deps.socket.connected) return;
      try {
        const ack = await this.deps.socket.timeout(6000).emitWithAck("record:status", {
          recordingId: this.deps.recordingId,
          ...fields,
        });
        if (ack?.ok) return;
      } catch {
        /* hub busy — retry */
      }
      await sleepMs(800);
    }
  }

  async finalize(finalState) {
    if (this.state === "finalizing" || this.done) return;
    this.state = "finalizing";
    for (const t of this.timers) {
      clearTimeout(t);
      clearInterval(t);
    }
    this.timers.length = 0;
    const d = this.deps;
    const endedAt = new Date().toISOString();
    for (let i = 0; i < 10 && this.pending.length > 0; i++) {
      await this.flush(true);
      if (this.pending.length > 0) await sleepMs(1500);
    }
    const sizeBytes = this.totalBytes;
    const sha256 = this.hash.digest("hex");
    const fileName = `${d.recordingId}.enc`;
    let manifestOk = false;
    for (let attempt = 1; attempt <= 3 && !manifestOk; attempt++) {
      if (!d.socket.connected) {
        await sleepMs(1200);
        continue;
      }
      try {
        const ack = await d.socket.timeout(8000).emitWithAck("record:manifest", { recordingId: d.recordingId, fileName, sizeBytes, sha256 });
        if (ack?.ok) manifestOk = true;
        else console.error(`[AGENT] record:manifest rejected (attempt ${attempt}): ${ack?.error ?? "unknown"}`);
      } catch (e) {
        console.error(`[AGENT] record:manifest failed (attempt ${attempt}): ${e instanceof Error ? e.message : e}`);
      }
      if (!manifestOk) await sleepMs(1200);
    }
    await this.status({ state: finalState, endedAt, sizeBytes, frames: this.frames }, 3);
    this.done = true;
    console.log(
      `[AGENT] recording ${d.recordingId} ${finalState} — ${sizeBytes} bytes, ${this.frames} frames, sha256 ${sha256.slice(0, 12)}…${manifestOk ? "" : " (upload incomplete — buffered locally)"}`,
    );
  }

  cancel() {
    if (this.state === "armed") {
      for (const t of this.timers) {
        clearTimeout(t);
        clearInterval(t);
      }
      this.timers.length = 0;
      this.state = "canceled";
      this.done = true;
      console.log(`[AGENT] recording ${this.deps.recordingId} canceled before start — on-device notice cleared`);
      void this.status({ state: "canceled", endedAt: new Date().toISOString() });
      return;
    }
    if (this.state === "recording") {
      console.log(`[AGENT] recording ${this.deps.recordingId} canceled by the operator — sealing artifact`);
      void this.finalize("canceled");
    }
  }
}

// ── main ─────────────────────────────────────────────────────────────────
async function main() {
  const cfg = loadConfig(parseArgs(process.argv));
  if (cfg.help) {
    console.log(HELP);
    return;
  }
  const info = await buildAgentInfo(cfg);
  const captures = await collectCaptures();
  if (cfg.printInfo) {
    console.log(JSON.stringify({ ...info, captures }, null, 2));
    return;
  }

  const metrics = new Metrics();
  const files = new FileScope(cfg.fsRoot);
  const bootTime = Date.now() - os.uptime() * 1000;

  console.log("┌──────────────────────────────────────────────────────────┐");
  console.log("│  SentraRMM agent — THIS AGENT IS VISIBLE BY DESIGN       │");
  console.log("│  It registers on the operator console and the device     │");
  console.log("│  user can stop it at any time with Ctrl+C.               │");
  console.log("└──────────────────────────────────────────────────────────┘");
  console.log(`[AGENT] v${AGENT_VERSION} → hub ${cfg.hub}`);
  console.log(`[AGENT] device ${info.hostname} (${info.osName} ${info.osVersion}, ${info.cpuCores} cores, ${info.totalMemoryMB}MB)`);
  console.log(
    `[AGENT] agentId ${info.agentId}  tags=[${info.tags.join(", ")}]  fileScope=${files.root}`,
  );
  console.log(
    `[AGENT] captures: ${captures.monitors.length} monitor(s), ${captures.cameras.length} camera(s), ${captures.mics.length} mic(s) — shells: ${captures.shells.join(", ") || "bash"}`,
  );

  const socket = io(cfg.hub, {
    path: "/",
    reconnectionDelayMax: 10_000,
    transports: ["websocket", "polling"],
  });

  // v0.3 multi-source streams (any number simultaneous) + scheduled recordings.
  // The Node reference agent streams the SCREEN kind only — camera/mic and
  // multi-monitor capture get an honest error pointing at agent-python.
  const streams = new Map(); // streamId → { seq, timer, fps }
  const recordings = new Map(); // recordingId → ScreenRecorder

  socket.on("connect", () => {
    console.log(`[AGENT] connected to hub (socket ${socket.id})`);
    socket.emit("agent:register", { info: { ...info, captures } }, (ack) => {
      if (ack?.ok) console.log("[AGENT] registered — device should now appear in the console");
      else console.error("[AGENT] registration rejected:", ack?.error ?? "unknown error");
    });
    // v0.3: a recording may have buffered chunks while the hub was down.
    for (const rec of recordings.values()) {
      if (!rec.done && rec.state === "recording") void rec.flush(true);
    }
  });
  socket.on("disconnect", (reason) => {
    console.log(`[AGENT] disconnected (${reason}) — reconnecting`);
    // v0.3 contract: agents stop all streams when they disconnect. Recordings
    // KEEP RUNNING — chunks stay buffered in memory and flush on reconnect.
    for (const [streamId, stream] of streams) {
      clearInterval(stream.timer);
      streams.delete(streamId);
      console.log(`[AGENT] stream ${streamId.slice(0, 8)}… stopped (hub disconnect)`);
    }
  });
  socket.on("connect_error", (err) => console.error(`[AGENT] hub connection error: ${err.message}`));

  // heartbeat loop
  const beat = async () => {
    if (!socket.connected) return;
    const snap = await metrics.snapshot(info.agentId, Math.floor((Date.now() - bootTime) / 1000));
    socket.emit("agent:heartbeat", { agentId: info.agentId, metrics: snap, location: null });
    console.log(
      `[AGENT] heartbeat cpu=${snap.cpuPercent}% mem=${snap.memoryPercent}% disk=${snap.diskPercent}% net=↑${snap.netUpKBps}KBps ↓${snap.netDownKBps}KBps`,
    );
  };
  const beatTimer = setInterval(() => void beat(), cfg.heartbeatSec * 1000);
  void beat();

  // request handlers
  const handlers = {
    exec: async (p) => {
      const cmd = String(p.command ?? "");
      const shell = String(p.shell ?? "powershell");
      if (shell === "auto" && IS_WIN) await hasPowerShell(); // resolve "auto" before choosing
      console.log(`[AGENT] exec (${shell}): ${cmd}`);
      return execCommand(cmd, shell, cfg.hiddenExec);
    },
    "ps:list": async () => ({
      processes: IS_WIN ? await listProcessesWindows() : await listProcessesPosix(),
      metrics: await metrics.snapshot(info.agentId, Math.floor((Date.now() - bootTime) / 1000)),
    }),
    "ps:action": (p) => processAction(Number(p.pid), String(p.action)),
    "fs:list": (p) => files.list(String(p.path ?? ".")),
    "fs:download": (p) => files.download(String(p.path)),
    "fs:upload": (p) => files.upload(String(p.path), String(p.name), String(p.contentBase64)),
    "fs:delete": (p) => files.remove(String(p.path)),
    "fs:rename": (p) => files.rename(String(p.path), String(p.newName)),
    "fs:mkdir": (p) => files.mkdir(String(p.path)),
    "media:screenshot": async () => {
      const shot = await captureScreen();
      console.log(`[AGENT] screenshot captured (${Math.round(shot.sizeBytes / 1024)}KB)`);
      return shot;
    },
    "location:fix": () => {
      throw new Error("location:fix is not implemented in the reference agent (needs an OS/edge geolocation source)");
    },
    "media:record": () => {
      throw new Error("media:record needs a native capture stack (WASAPI/MediaFoundation) — not shipped in the reference agent");
    },
    "net:start": () => {
      throw new Error("net:start needs a packet-capture backend (pktcap/pcap) — not shipped in the reference agent");
    },
    "net:stop": () => {
      throw new Error("net:stop needs a packet-capture backend (pktcap/pcap) — not shipped in the reference agent");
    },
  };

  let live = null; // { timer, seq } — legacy screen:live channel
  const startStream = (p) => {
    const streamId = String(p.streamId ?? "");
    if (!streamId) throw new Error("streamId is required");
    const kind = String(p.kind ?? "");
    if (kind !== "screen") {
      throw new Error(
        kind === "camera" || kind === "mic"
          ? "camera/mic streaming is not implemented in the reference agent — use the Python agent (agent-python)"
          : "kind must be one of: screen, camera, mic",
      );
    }
    const sourceId = p.sourceId == null || p.sourceId === "" ? null : String(p.sourceId);
    if (!screenStreamAllowed(sourceId)) {
      throw new Error("multi-monitor capture requires the Python agent (agent-python) — only the primary display streams here");
    }
    if (streams.has(streamId)) throw new Error(`Stream '${streamId}' is already running`);
    const fps = Math.min(5, Math.max(0.5, Number(p.fps) > 0 ? Number(p.fps) : 2));
    const mon = captures.monitors[0];
    const stream = { streamId, seq: 0, timer: setInterval(() => void pushStreamFrame(stream), Math.round(1000 / fps)) };
    streams.set(streamId, stream);
    console.log(`[AGENT] stream ${streamId.slice(0, 8)}… screen started (${fps} fps, primary display)`);
    return {
      started: true,
      meta: { width: mon?.width ?? 0, height: mon?.height ?? 0, fps, sourceId: "monitor:0" },
    };
  };

  const pushStreamFrame = async (stream) => {
    if (!socket.connected) return;
    if (!streams.has(stream.streamId)) return;
    try {
      stream.seq += 1;
      const shot = await captureScreen();
      socket.emit("agent:event", {
        name: "stream:frame",
        payload: {
          agentId: info.agentId,
          streamId: stream.streamId,
          kind: "screen",
          dataUri: shot.dataUri,
          ts: Date.now(),
          seq: stream.seq,
          width: captures.monitors[0]?.width ?? 0,
          height: captures.monitors[0]?.height ?? 0,
        },
      });
    } catch (err) {
      console.error(`[AGENT] stream frame failed: ${err instanceof Error ? err.message : err}`);
    }
  };

  const stopStream = (p) => {
    const streamId = String(p.streamId ?? "");
    const stream = streams.get(streamId);
    if (!stream) return { frames: 0 };
    clearInterval(stream.timer);
    streams.delete(streamId);
    console.log(`[AGENT] stream ${streamId.slice(0, 8)}… stopped (${stream.seq} frames)`);
    return { frames: stream.seq };
  };

  const scheduleRecording = (p) => {
    const recordingId = String(p.recordingId ?? "");
    if (!recordingId) throw new Error("recordingId is required");
    const passphrase = String(p.passphrase ?? "");
    if (!passphrase) throw new Error("passphrase is required");
    if (!IS_WIN) {
      throw new Error(
        "scheduled recordings are implemented on Windows only in the reference agent (GDI+ screen capture) — use the Python agent (agent-python) on this platform",
      );
    }
    if (recordings.has(recordingId)) throw new Error(`Recording '${recordingId}' already exists`);
    const durationSec = Math.max(5, Math.round(Number(p.durationSec) || 0));
    const label = typeof p.label === "string" && p.label.trim() !== "" ? p.label.trim() : null;
    const monitors = Array.isArray(p.monitors) ? p.monitors.filter((m) => typeof m === "string") : [];
    const sourceId = monitors[0] ?? "monitor:0";
    if (!screenStreamAllowed(sourceId)) {
      throw new Error("multi-monitor recording requires the Python agent (agent-python) — only the primary display records here");
    }
    // TRANSPARENCY (contract, non-optional): announce the armed recording to
    // the device user before it starts.
    console.log("┌──────────────────────────────────────────────────────────┐");
    console.log("│  SCHEDULED RECORDING ARMED BY THE ADMINISTRATOR          │");
    console.log(`│  id ${recordingId}`);
    console.log(`│  duration ${durationSec}s · source ${sourceId}${label ? ` · label: ${label}` : ""}`);
    console.log(`│  ${String(p.noticeText ?? "A visible indicator will be shown while recording.").slice(0, 56)}`);
    console.log("└──────────────────────────────────────────────────────────┘");
    const rec = new ScreenRecorder({ socket, agentId: info.agentId, recordingId, durationSec, passphrase, label, sourceId });
    recordings.set(recordingId, rec);
    rec.arm();
    return { accepted: true, state: "armed" };
  };

  const cancelRecording = (p) => {
    const recordingId = String(p.recordingId ?? "");
    const rec = recordings.get(recordingId);
    if (!rec || rec.done) {
      console.log(`[AGENT] record:cancel ${recordingId}: no active recording`);
      return { ok: true, state: "idle" };
    }
    rec.cancel();
    return { ok: true, state: "canceled" };
  };

  socket.on("agent:request", (msg) => {
    if (!msg || typeof msg.requestId !== "string" || typeof msg.type !== "string") return;
    const payload = msg.payload ?? {};
    Promise.resolve()
      .then(() => {
        if (msg.type === "screen:live:start") {
          if (live) throw new Error("A live screen stream is already running");
          const fps = Math.min(3, Math.max(0.5, Number(payload.fps) > 0 ? Number(payload.fps) : 1));
          live = { seq: 0, timer: setInterval(() => void pushFrame(fps), Math.round(1000 / fps)) };
          console.log(`[AGENT] live screen started (${fps} fps)`);
          return { started: true, fps };
        }
        if (msg.type === "screen:live:stop") {
          if (!live) return { frames: 0 };
          clearInterval(live.timer);
          console.log(`[AGENT] live screen stopped (${live.seq} frames)`);
          const frames = live.seq;
          live = null;
          return { frames };
        }
        if (msg.type === "stream:start") return startStream(payload);
        if (msg.type === "stream:stop") return stopStream(payload);
        if (msg.type === "record:schedule") return scheduleRecording(payload);
        if (msg.type === "record:cancel") return cancelRecording(payload);
        const h = handlers[msg.type];
        if (!h) throw new Error(`Unknown request type '${msg.type}'`);
        return h(payload);
      })
      .then((data) => socket.emit("agent:reply", { requestId: msg.requestId, ok: true, data }))
      .catch((err) => {
        socket.emit("agent:reply", { requestId: msg.requestId, ok: false, error: err instanceof Error ? err.message : String(err) });
        console.error(`[AGENT] ${msg.type} failed: ${err instanceof Error ? err.message : String(err)}`);
      });
  });

  const pushFrame = async (fps) => {
    if (!live || !socket.connected) return;
    try {
      shotSeq += 1;
      live.seq += 1;
      const shot = await captureScreen();
      socket.emit("agent:event", {
        name: "screen:frame",
        payload: { agentId: info.agentId, dataUri: shot.dataUri, ts: Date.now(), seq: live.seq, width: 0, height: 0 },
      });
    } catch (err) {
      console.error(`[AGENT] live frame failed: ${err instanceof Error ? err.message : err}`);
      clearInterval(live.timer);
      live = null;
    }
  };

  const shutdown = (signal) => {
    console.log(`[AGENT] ${signal} received — disconnecting from hub`);
    clearInterval(beatTimer);
    if (live?.timer) clearInterval(live.timer);
    for (const [, stream] of streams) clearInterval(stream.timer);
    streams.clear();
    for (const rec of recordings.values()) {
      if (!rec.done) rec.cancel(); // visible: Ctrl+C stops any active recording
    }
    socket.disconnect();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("[AGENT] fatal:", err);
  process.exit(1);
});
