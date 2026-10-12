#!/usr/bin/env python3
"""Build a PyFortress-protected distribution of the SentraRMM Python agent.

The vendored PyFortress tool (build/pyfortress/, unmodified) is driven as a
subprocess: ``python -m pyfortress protect agent.py sentra_agent -O dist_agent
<flags>``. Output keeps the input filenames, so dist_agent/agent.py +
dist_agent/sentra_agent/ + dist_agent/fortress_runtime/ ship together.

Protection levels (mapped to PyFortress flag sets):
  light      container encryption only                [--no-mix-str --no-rft --no-antidebug --obf-code 1]
  standard   defaults                                 [--mix-str --rft --antidebug --obf-code 1]
  strong     + stricter renaming, no docstrings       [--mix-str --rft --antidebug --strip-docstrings --obf-code 2]
  maximum    strong + wrap mode (re-encrypt on exit)  [strong + --wrap]

ANTI-TAMPER GUARD: this script embeds the sha256 of sentra_agent/transparency.py
and REFUSES to build when the file is missing or modified — the transparency
features (banner, action toasts, tray icon, recording overlay) are mandatory
and must not be stripped during "protection". If you intentionally changed
transparency.py, update the embedded hash with
``--update-transparency-hash`` and commit the new value with your change.

Usage:
    python build/build_encrypted.py --level strong [-O dist_agent] [--expire-days N]
                                    [--pack onefile|onedir] [--update-transparency-hash]

Windows deployment notes: run on a Windows box with Python 3.10+ and
``pip install -r requirements.txt``; add ``--pack onefile`` (needs PyInstaller)
to get a single agent.exe. See build/README.md.
"""
from __future__ import annotations

import argparse
import hashlib
import os
import subprocess
import sys
from typing import Dict, List, Optional

AGENT_VERSION = "0.3.0"
DEFAULT_OUT = "dist_agent"

#: sha256 of sentra_agent/transparency.py — the anti-tamper manifest.
#: Regenerate with: python build/build_encrypted.py --update-transparency-hash
TRANSPARENCY_SHA256 = "b0ff224beb30c7caeb82e53649dda9a9b9b89bfad5a3c0e1cb4a959342ad175b"

LEVEL_FLAGS: Dict[str, List[str]] = {
    "light": ["--no-mix-str", "--no-rft", "--no-antidebug", "--obf-code", "1"],
    "standard": ["--obf-code", "1"],
    "strong": ["--mix-str", "--rft", "--antidebug", "--strip-docstrings",
               "--obf-code", "2"],
    "maximum": ["--mix-str", "--rft", "--antidebug", "--strip-docstrings",
                "--obf-code", "2", "--wrap"],
}


def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for block in iter(lambda: fh.read(65536), b""):
            h.update(block)
    return h.hexdigest()


def project_root() -> str:
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def check_transparency(root: str, update: bool) -> int:
    """Verify (or update) the embedded transparency.py hash."""
    path = os.path.join(root, "sentra_agent", "transparency.py")
    if not os.path.isfile(path):
        print("BUILD REFUSED: sentra_agent/transparency.py is missing.\n"
              "  Transparency features are MANDATORY; a build without them must never ship.",
              file=sys.stderr)
        return 1
    actual = sha256_file(path)
    if update:
        print("update the embedded TRANSPARENCY_SHA256 in build/build_encrypted.py to:")
        print(f'TRANSPARENCY_SHA256 = "{actual}"')
        return 0
    if actual != TRANSPARENCY_SHA256:
        print("BUILD REFUSED: sentra_agent/transparency.py does not match the embedded "
              "sha256 manifest (missing/tampered transparency features).\n"
              f"  expected {TRANSPARENCY_SHA256}\n"
              f"  actual   {actual}\n"
              "  If you INTENTIONALLY changed transparency.py, refresh the manifest with "
              "--update-transparency-hash and commit it alongside the change.",
              file=sys.stderr)
        return 1
    print(f"[tamper-check] transparency.py verified ({actual[:16]}…)")
    return 0


def run_protect(root: str, out_dir: str, level: str, expire_days: Optional[int],
                pack: Optional[str], bundle_name: str) -> int:
    build_dir = os.path.join(root, "build")
    env = dict(os.environ)
    env["PYTHONPATH"] = build_dir + (os.pathsep + env["PYTHONPATH"] if env.get("PYTHONPATH") else "")
    inputs = [os.path.join(root, "agent.py"), os.path.join(root, "sentra_agent")]
    cmd = [sys.executable, "-m", "pyfortress", "protect", *inputs, "-O", out_dir,
           *LEVEL_FLAGS[level]]
    if expire_days:
        cmd += ["-e", str(expire_days)]
    if pack:
        cmd += ["--pack", pack]
    if bundle_name:
        cmd += ["--name", bundle_name]
    print("[build]", " ".join(cmd))
    proc = subprocess.run(cmd, cwd=root, env=env)
    return proc.returncode


def verify_output(root: str, out_dir: str) -> int:
    """Run the protected entry with --print-info and require valid JSON."""
    entry = os.path.join(root, out_dir, "agent.py")
    if not os.path.isfile(entry):
        print(f"[verify] FAIL — {entry} not produced", file=sys.stderr)
        return 1
    print(f"[verify] running protected agent: python {entry} --print-info")
    proc = subprocess.run([sys.executable, entry, "--print-info"],
                          cwd=os.path.join(root, out_dir),
                          capture_output=True, text=True, timeout=60)
    if proc.returncode != 0:
        print(f"[verify] FAIL — exit {proc.returncode}\n{proc.stderr[-2000:]}",
              file=sys.stderr)
        return 1
    import json

    try:
        data = json.loads(proc.stdout)
        assert data.get("agentId") and data.get("captures")
    except Exception as exc:  # noqa: BLE001
        print(f"[verify] FAIL — --print-info output invalid: {exc}\n{proc.stdout[-800:]}",
              file=sys.stderr)
        return 1
    print(f"[verify] OK — agentId={data['agentId']}, "
          f"captures: monitors={len(data['captures'].get('monitors', []))}, "
          f"cameras={len(data['captures'].get('cameras', []))}, "
          f"mics={len(data['captures'].get('mics', []))}, "
          f"shells={data['captures'].get('shells', [])}, "
          f"notes={len(data['captures'].get('notes', []))}")
    return 0


def write_checksums(root: str, out_dir: str) -> int:
    """Write dist_agent/checksums.txt (sha256 of every output file)."""
    dest = os.path.join(root, out_dir, "checksums.txt")
    try:  # drop a stale checksum file so it never checksums itself
        os.remove(dest)
    except OSError:
        pass
    lines: List[str] = []
    for dirpath, dirnames, filenames in os.walk(os.path.join(root, out_dir)):
        dirnames[:] = sorted(d for d in dirnames if d != "__pycache__")
        for name in sorted(filenames):
            full = os.path.join(dirpath, name)
            rel = os.path.relpath(full, os.path.join(root, out_dir))
            lines.append(f"{sha256_file(full)}  {rel.replace(os.sep, '/')}")
    payload = "\n".join(lines) + "\n"
    with open(dest, "w", encoding="utf-8") as fh:
        fh.write(payload)
    print(payload)
    print(f"[checksums] written to {dest} ({len(lines)} files)")
    return 0


def main(argv: Optional[List[str]] = None) -> int:
    ap = argparse.ArgumentParser(description="PyFortress build for the SentraRMM agent")
    ap.add_argument("--level", default="strong", choices=sorted(LEVEL_FLAGS))
    ap.add_argument("-O", "--out", default=DEFAULT_OUT, help="output dir (default dist_agent)")
    ap.add_argument("--expire-days", type=int, default=None,
                    help="pass -e DAYS to PyFortress (build expires after N days)")
    ap.add_argument("--pack", default=None, choices=["onefile", "onedir"],
                    help="PyInstaller passthrough (needs PyInstaller; Windows one-file exe)")
    ap.add_argument("--name", default="agent", help="bundle name for --pack")
    ap.add_argument("--update-transparency-hash", action="store_true",
                    help="print the new transparency.py sha256 instead of building")
    args = ap.parse_args(argv)

    root = project_root()
    tamper = check_transparency(root, args.update_transparency_hash)
    if args.update_transparency_hash:
        return tamper
    if tamper != 0:
        return tamper

    rc = run_protect(root, args.out, args.level, args.expire_days, args.pack, args.name)
    if rc != 0:
        print(f"[build] pyfortress protect failed (exit {rc})", file=sys.stderr)
        return rc

    if verify_output(root, args.out) != 0:
        return 1
    write_checksums(root, args.out)

    print(f"\n[done] level={args.level} out={args.out}/ — ship {args.out}/agent.py, "
          f"{args.out}/sentra_agent/ and {args.out}/fortress_runtime/ together.")
    if args.pack:
        print(f"[note] --pack {args.pack} output is under {args.out}/ (see PyInstaller logs). "
              "On Windows, a one-file agent.exe still shows the console + tray + overlay: "
              "transparency ships in the binary.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
