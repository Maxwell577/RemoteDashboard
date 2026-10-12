# SentraRMM

A transparent Remote Monitoring & Management (RMM) system for **your own machines** — liquid-glass web dashboard + cross-platform agents. Designed so the operator and the device user always see the same thing.

> **Transparency by design.** No stealth, no hiding, no covert capture. Every feature on this list is visible to the device user: the agent runs as a named process, shows a banner on start, raises toast notifications on every remote action, and screen recording displays an unclosable overlay. See [agent-python/README.md](agent-python/README.md).

## What's inside

| Path | What it is |
|---|---|
| `src/` | Next.js 16 dashboard (App Router) — devices, terminal, multi-stream live capture, recordings, audit |
| `mini-services/agent-hub/` | Socket.IO realtime hub (port 3003) + 3 simulated demo agents |
| `agent/` | Node.js ≥18 reference agent (no build step, ESM) |
| `agent-python/` | **Python agent + PyFortress encrypted build pipeline** (main deliverable) |
| `agent-python/build/vendor/Pyfotress.zip` | Original PyFortress tool (provenance copy, as uploaded) |
| `agent-python/build/build_encrypted.py` | One-command encrypted build (`--level strong`) |
| `agent-python/dist_agent/` | Last verified encrypted build output + `checksums.txt` |
| `prisma/`, `db/` | Prisma schema (SQLite); run `bun run db:push` to create the DB locally |

## Quick start (dashboard)

```bash
bun install
bun run db:push
bun run dev        # dashboard on :3000, hub on :3003
```

## Python agent (encrypted build)

```bash
cd agent-python
pip install -r requirements.txt

# build the encrypted distribution (vendored PyFortress, level: strong)
python3 build/build_encrypted.py --level strong

# run it (visible banner + tray icon; honest errors on unsupported features)
python3 dist_agent/agent.py --hub http://localhost:3003
```

The build wraps every module with the vendored **PyFortress** protector (string mixing, RFT-safe
cross-module calls, anti-debug, docstring stripping, per-module ChaCha20 encryption) and emits
`dist_agent/` with a `checksums.txt` manifest. See `agent-python/README.md` for the full
transparency contract and feature table.

## Recorded offline captures

Screen/mic recordings are AES-256-GCM encrypted (PBKDF2-SHA256 200k) with the passphrase chosen
at schedule time. Decrypt any `.enc` artifact — from the agent, the hub vault, or a downloaded
copy — with the bundled tool:

```bash
python3 agent-python/tools/decrypt_recording.py list   artifact.enc --passphrase '...'
python3 agent-python/tools/decrypt_recording.py unpack artifact.enc --out ./dec --passphrase '...'
```

## License / intent

For managing machines you own. Do not use it on devices you don't own or lack consent to monitor.
