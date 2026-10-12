# SentraRMM reference agent (Node.js, cross-platform)

A **transparent** remote-management agent for machines you own. It connects to a
SentraRMM hub over socket.io and appears in the console like any other device.

> **By design, this agent is not stealthy.** It prints a visible banner, keeps a
> console window open, registers itself in the operator's device list, and
> briefly flashes a PowerShell window whenever a remote command runs (disable
> with `--hidden-exec`). The device user can stop it with `Ctrl+C` at any time.
> If you need invisibility, this project is not for you.

## Requirements

- Node.js **18.15+** (Windows, macOS or Linux) — <https://nodejs.org>
- Network access from the device to the hub (default `http://<hub-host>:3003`)

## Install & run

```powershell
# on the managed Windows machine
cd agent
npm install
node index.mjs --hub http://HUB-HOST:3003 --name "Work Laptop" --tags work,live
```

The device appears in the SentraRMM console immediately (health ring, telemetry
sparkline, alerts, audit trail all work from the first heartbeat).

### Config file

`sentra-agent.config.json` next to `index.mjs` is loaded automatically; CLI
flags override it:

```json
{
  "hubUrl": "http://192.168.1.10:3003",
  "friendlyName": "Work Laptop",
  "agentId": "node-work-laptop-a1b2",
  "tags": ["work"],
  "heartbeatSec": 15,
  "deviceType": "laptop",
  "fsRoot": "C:\\Users\\you",
  "hiddenExec": false
}
```

## What the hub can do on this agent

| Request type | Implementation |
| --- | --- |
| `exec` | Real shell — `shell` param selects `powershell` / `cmd` / `auto` on Windows (auto = powershell if available, cmd fallback), `bash` on Linux/macOS; the reply always reports the effective shell. 25s timeout, output capped at 256 KB. |
| `ps:list` / `ps:action` | Real process table (`Get-Process` / `ps`), kill / suspend / resume (suspend+resume are POSIX-only). |
| `fs:list/download/upload/delete/rename/mkdir` | Real filesystem, **scoped to `--root`** (default: user home). Path traversal out of the root is rejected. |
| `media:screenshot` | Real GDI+ screen capture on Windows. On other platforms it errors unless ImageMagick `import` is available. |
| `screen:live:start/stop` | Periodic `media:screenshot` frames pushed as `agent:event` (0.5–3 fps). |
| `stream:start/stop` | v0.3 multi-source streams — **screen kind only**, primary display only, 0.5–5 fps, any number of streams at once. `camera` / `mic` and non-primary `sourceId` are ❌ reported honestly (need the Python agent). |
| `record:schedule/cancel` | v0.3 scheduled **screen-only** recording on Windows: 2 fps GDI+ screenshots sealed into a `SENTRA-REC-1` artifact (AES-256-GCM, PBKDF2-HMAC-SHA256 200k iterations, AAD binds chunks to the recordingId), uploaded as ordered acked `record:chunk` events (≤256 KB payload) + `record:manifest`. The recording **continues while the hub is unreachable** (chunks buffer in memory, flush on reconnect). ❌ POSIX: reported honestly — use the Python agent. |
| `location:fix` | ❌ Reported honestly as unimplemented (needs an OS/edge geolocation source). |
| `media:record`, `net:start/stop` | ❌ Reported honestly as unimplemented (need WASAPI / packet-capture backends). |

### Capture capabilities reported at register time

| Source | Windows | Linux/macOS |
| --- | --- | --- |
| monitors | ✅ `System.Windows.Forms.Screen.AllScreens` (id `monitor:0…`, primary first) | ❌ empty + honest note |
| cameras | ❌ empty + note (camera capture needs the Python agent) | ❌ empty + note |
| mics | ❌ empty + note (mic capture needs the Python agent) | ❌ empty + note |
| shells | `powershell`, `cmd` | (exec uses `/bin/bash`) |

## Scheduled recordings — transparency & encryption

- When the console arms a recording, the agent **prints a visible notice** on
  the device before it starts, and logs every frame while it records. This
  behavior is not optional and cannot be disabled.
- The artifact (`<recordingId>.enc`) is encrypted end-to-end: the passphrase
  never leaves the console, the agent only receives it for the local
  PBKDF2 key derivation, and the hub stores just the sealed bytes.
- Recording is **screen-only** in this reference agent; camera/mic recording
  is available through the Python agent (agent-python).

## Run as a background service (optional)

The reference agent is intentionally a plain foreground process. For a
service-style install on Windows use Task Scheduler or NSSM, e.g.:

```powershell
schtasks /Create /TN "SentraRMM agent" /SC ONLOGON ^
  /TR "node C:\path\to\agent\index.mjs --hub http://HUB:3003" /RL LIMITED
```

Keep it visible: an agent the device user can see and question is the whole
point of SentraRMM.
