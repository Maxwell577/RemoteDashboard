# SentraRMM Python agent (v0.3)

A **transparent** remote-management agent for Windows (cross-platform capable),
written in Python. It speaks the frozen v0.3 socket.io protocol of the
SentraRMM hub (see the bottom of `../src/lib/types.ts`) and implements:

| Area | What it does |
|---|---|
| Registration | `agent:register` with the full `AgentInfo` + `CaptureCapabilities` (monitors / cameras / mics / shells / honest notes) |
| Telemetry | `agent:heartbeat` every `heartbeatSec` with real psutil `DeviceMetrics` |
| Remote shell | `exec` — PowerShell / cmd / auto on Windows, bash on POSIX; effective shell always reported |
| Files | `fs:list/download/upload/delete/rename/mkdir`, scoped to the configured root |
| Processes | `ps:list`, `ps:action` (kill / suspend / resume) via psutil |
| Screenshot | `media:screenshot` (mss; Windows GDI-via-PowerShell fallback) |
| Live streams | `stream:start/stop` — screen (mss, fps ≤ 5), camera (OpenCV, fps ≤ 15), mic (sounddevice RMS @ 8 Hz), any number concurrent |
| Recordings | `record:schedule/cancel/status` — encrypted **SENTRA-REC-1** artifacts (AES-256-GCM + PBKDF2-HMAC-SHA256, 200 000 iterations), ordered ≤ 256 KB `record:chunk`s with ack/retry, `record:manifest` at the end, **offline-safe** (local spool + local `.enc` file, flushed on reconnect) |

## Quick start

```bash
pip install -r requirements.txt

# inspect what this machine can capture, without connecting anywhere
python agent.py --print-info

# connect to the hub (default http://127.0.0.1:3003)
python agent.py --hub http://127.0.0.1:3003 --name "Lab Workstation" --tags lab,windows
```

Useful flags: `--agent-id`, `--interval 5..300`, `--recordings-dir`,
`--type workstation|laptop|server`, `--config FILE`, `--save-config`,
`--print-info`, `--version`. Environment: `SENTRA_HUB`, `SENTRA_NAME`,
`SENTRA_TAGS`, `SENTRA_AGENT_ID`. Config file: `config.json` next to
`agent.py` (see `config.sample.json`; copy it to `config.json` and edit).
Precedence: **CLI > environment > config.json > defaults**.

## TRANSPARENCY — non-optional by design

This agent manages a device that belongs to a *person*. Every remote action is
therefore **announced on the device**, and this is enforced in code, not by
configuration:

| Transparency behaviour | Where | How it looks |
|---|---|---|
| Startup banner | `transparency.print_banner` | Console box: *“THIS AGENT IS VISIBLE BY DESIGN … the device user can stop it with Ctrl+C”* + version / device / agentId / hub |
| Action toasts | `transparency.Notifier` (plyer, console fallback) | A desktop notification **and** a console line for every remote exec, file operation, stream, screenshot and recording event |
| Recording overlay | `transparency.RecordingOverlay` (tkinter) | A topmost, borderless, unclosable rose-red banner **“● Recording — SentraRMM managed session”** with a blinking dot, shown for the entire recording and withdrawn when it ends |
| Tray icon | `transparency.TrayIcon` (pystray) | Green dot = visible/idle, red dot = recording; menu with About + Status |
| Schedule notice | `recorder.RecordingManager.schedule` | The device user is notified **before** the `record:schedule` ack is sent, using the operator's `noticeText` when provided |

**There is no config key, CLI flag or environment variable that can disable any
of these.** `transparency.py` is constructed unconditionally by `agent.py`
(`Transparency()` — no argument to pass), a `TRANSPARENCY_ENFORCED = False`
tamper makes the agent refuse to start, and `build/build_encrypted.py` embeds
the sha256 of `transparency.py` and **refuses to build** if the file is
missing or modified. Headless machines degrade to explicit console logging
(the console channel is always active) — the features never silently vanish.

## Encrypted recordings (SENTRA-REC-1)

Identical to the Node agent and the hub (frozen format):

```
Line 1 (ASCII, \n-terminated): JSON header
  { magic: "SENTRA-REC-1", cipher: "AES-256-GCM", kdf: "PBKDF2-HMAC-SHA256",
    iterations: 200000, salt: <b64 16B>, agentId, recordingId, label?,
    durationSec, sources: [...], startedAt: epochMs }
Then framed records: [u32 BE length][12B nonce][ciphertext][16B tag]
  plaintext = newline-delimited JSON { t, kind: "screen"|"camera"|"mic"|"meta",
                                       sourceId?, mime?, dataB64?, level? }
key = PBKDF2-HMAC-SHA256(passphrase, salt, iterations, 32 bytes)
AAD = first 16 bytes of sha256(recordingId)
```

* The passphrase is used for key derivation only — never logged, never sent.
* Chunks travel as ordered `record:chunk` events (seq from 0, ≤ 256 KB payload)
  and are retried (locally spooled to `recordings/spool/`) until the hub acks.
* A daemon job thread does the recording: **losing the hub never stops a
  recording.** The local `<recordingId>.enc` file is the offline-safe copy;
  chunks + manifest are flushed on reconnect.
* Guards: free-space check (`minFreeMB`), duration cap
  (`maxRecordingMin` × 60 s), max 2 concurrent recordings, JPEG frame cap so a
  chunk can never cross the 256 KB contract limit.

### Decrypting a recording

```bash
python tools/decrypt_recording.py <recordingId>.enc --passphrase '...' [--out DIR]
python tools/decrypt_recording.py <recordingId>.enc --list          # header only
python tools/decrypt_recording.py <recordingId>.enc -p '...' --verify <sha256>
```

Output: `frame_%06d.jpg` (screen/camera), `levels.csv` (mic RMS samples),
`manifest.json` (header + summary + meta records). A wrong passphrase fails
cleanly with an authentication error (exit 1).

## Protected build (PyFortress)

```bash
python build/build_encrypted.py --level strong          # → dist_agent/
python build/build_encrypted.py --level maximum --pack onefile   # Windows exe (needs PyInstaller)
```

Levels: `light` (container encryption only) → `standard` → `strong`
(`--mix-str --rft --antidebug --strip-docstrings --obf-code 2`) → `maximum`
(strong + `--wrap`). The tool runs the vendored PyFortress
(`build/pyfortress/`, unmodified) as a subprocess with
`python -m pyfortress protect agent.py sentra_agent -O dist_agent …`,
verifies the output (`--print-info` must produce valid JSON), writes
`dist_agent/checksums.txt`, and enforces the transparency anti-tamper check
described above. Ship `dist_agent/agent.py` + `sentra_agent/` +
`fortress_runtime/` together; `--pack onefile` yields a single `agent.exe`
on Windows (console + tray + overlay still ship inside it).

## Layout

```
agent.py                     entry point (CLI, AgentInfo, lifecycle)
sentra_agent/
  config.py                  defaults / validation / merge (no transparency knobs)
  captures.py                monitor/camera/mic/shell/interface enumeration + honest notes
  hublink.py                 socket.io client, heartbeat metrics, request routing, spool emit
  terminal.py                exec (powershell/cmd/auto/bash, 25 s timeout, 256 KB cap)
  fsops.py                   scoped file operations
  processes.py               ps:list / ps:action
  streams.py                 live screen/camera/mic streams
  recorder.py                scheduled encrypted recordings (state machine + spool)
  transparency.py            MANDATORY banner / toasts / overlay / tray
tools/decrypt_recording.py   offline decryptor for .enc artifacts
build/build_encrypted.py     PyFortress build + tamper check + checksums
build/pyfortress/            vendored protector (DO NOT MODIFY)
config.sample.json           sane defaults
```

## Honest limitations

| Limitation | Detail |
|---|---|
| Capture deps are optional at runtime | No `mss` → no live screen/screen recording; no `opencv-python` → no camera capture; no `sounddevice`/PortAudio → no mic. The agent still registers, reports honest empty lists + notes, and returns honest errors (never fake data). Install `requirements.txt` for full capability. |
| Linux needs a display server | mss/tkinter toasts need X/Wayland; headless boxes fall back to console transparency. |
| `exec` on POSIX | `shell` is accepted but everything runs under bash and the reply reports `"bash"` (the contract's PowerShell/cmd are Windows-only). |
| fs scope | Operations are rooted at the agent's `fsRoot` (default: user home); path traversal is refused; downloads capped at 20 MB inline; listings capped at 500 entries. |
| Recording duration cap | `maxRecordingMin` (default 60) — the agent rejects longer `record:schedule`s instead of silently truncating. |
| Hub restarts mid-recording | Chunk sequence numbers live in hub memory; if the hub process restarts mid-recording, later chunks are rejected as out-of-order until the recording is rescheduled. (Network blips are handled: spool + retry + manifest re-send.) |
| Camera names | OpenCV probes indices 0–5 but most backends don't expose device names, so cameras are reported as “Camera N (WxH)”. |
| `location:fix`, `net:start/stop` | Not implemented — honest `NotImplementedError` replies. |
| Windows-only paths are sandbox-untested | GDI screenshot fallback, `taskkill` tree-kill and per-monitor DPI behaviour were code-reviewed but can only be fully exercised on a real Windows host. |
