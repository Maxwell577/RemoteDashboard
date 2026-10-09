#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// SentraRMM reference agent v0.2.0
//
// A TRANSPARENT remote-management client. It speaks the exact same socket.io
// protocol as the simulated fleet bundled with the SentraRMM hub:
//
//   agent:register { info }                    → registers the device
//   agent:heartbeat { agentId, metrics, loc }  → telemetry every N seconds
//   agent:request { requestId, type, payload } → hub-initiated operations
//   agent:reply    { requestId, ok, data }     → operation result
//   agent:event    { name, payload }           → screen:frame live stream
//
// Supported request types (real implementations, no simulation):
//   exec                 — run a shell command (PowerShell on Windows)
//   ps:list / ps:action  — running processes + kill/suspend/resume
//   fs:list / fs:download / fs:upload / fs:delete / fs:rename / fs:mkdir
//                        — file operations, scoped to --root (default: home)
//   media:screenshot     — real screen capture on Windows (PowerShell + GDI+)
//   screen:live:start|stop — periodic screenshot frames over agent:event
//
// HONEST LIMITATIONS (the agent reports an explicit error, never fakes data):
//   media:record, net:start/stop and location:fix need native capture stack
//   (WASAPI / pktcap / OS geolocation) that this reference agent does not ship.
//
// This agent is designed to be SEEN: it prints a visible banner, keeps a
// console window, and briefly flashes a PowerShell window when remote
// commands run (disable with --hidden-exec). It registers itself in the
// operator's device list and the device user can close it at any time.
// ─────────────────────────────────────────────────────────────────────────────

import { io } from "socket.io-client";
import os from "node:os";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import crypto from "node:crypto";

const AGENT_VERSION = "0.2.0";
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

/** Run a remote command exactly like the terminal view expects. */
function execCommand(command, hiddenExec) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = IS_WIN
      ? spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command], {
          // Transparency: the PowerShell window is visible on the device by
          // default so users SEE remote activity. --hidden-exec disables it.
          windowsHide: hiddenExec === true,
        })
      : spawn("/bin/bash", ["-lc", command]);

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
      resolve({ output: out + `\n[spawn error] ${err.message}`, exitCode: 1, durationMs: Date.now() - started });
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

// ── main ─────────────────────────────────────────────────────────────────
async function main() {
  const cfg = loadConfig(parseArgs(process.argv));
  if (cfg.help) {
    console.log(HELP);
    return;
  }
  const info = await buildAgentInfo(cfg);
  if (cfg.printInfo) {
    console.log(JSON.stringify(info, null, 2));
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
  console.log(`[AGENT] agentId ${info.agentId}  tags=[${info.tags.join(", ")}]  fileScope=${files.root}`);

  const socket = io(cfg.hub, {
    path: "/",
    reconnectionDelayMax: 10_000,
    transports: ["websocket", "polling"],
  });

  socket.on("connect", () => {
    console.log(`[AGENT] connected to hub (socket ${socket.id})`);
    socket.emit("agent:register", { info }, (ack) => {
      if (ack?.ok) console.log("[AGENT] registered — device should now appear in the console");
      else console.error("[AGENT] registration rejected:", ack?.error ?? "unknown error");
    });
  });
  socket.on("disconnect", (reason) => console.log(`[AGENT] disconnected (${reason}) — reconnecting`));
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
    exec: (p) => {
      const cmd = String(p.command ?? "");
      console.log(`[AGENT] exec: ${cmd}`);
      return execCommand(cmd, cfg.hiddenExec);
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

  let live = null; // { timer, seq }
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
