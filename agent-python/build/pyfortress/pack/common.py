"""Shared helpers for packers."""
import os
import re
import subprocess
import sys


def dist_entry(args, opts):
    """Absolute path of the protected entry script inside the dist dir."""
    dist = os.path.abspath(opts.out)
    first = args.inputs[0] if getattr(args, "inputs", None) else "main.py"
    entry = os.path.basename(first)
    if not entry.endswith(".py"):
        entry += ".py"
    return dist, entry, os.path.join(dist, entry)


def needs_tkinter(inputs):
    """True if any ORIGINAL source references tkinter.

    Must scan the plaintext inputs, not the dist: the protected payloads are
    encrypted, so `import tkinter` inside them is invisible to the packer.
    """
    roots = [r for r in (inputs or ()) if r]
    for root in roots:
        root = os.path.abspath(root)
        files = []
        if os.path.isfile(root) and root.endswith(".py"):
            files.append(root)
        elif os.path.isdir(root):
            for dp, dns, fns in os.walk(root):
                dns[:] = [d for d in dns if d != "__pycache__" and not d.startswith(".")]
                files.extend(os.path.join(dp, f) for f in fns if f.endswith(".py"))
        for path in files:
            try:
                with open(path, "r", encoding="utf-8", errors="ignore") as f:
                    if re.search(r"\b(import\s+tkinter|from\s+tkinter)\b", f.read()):
                        return True
            except OSError:
                pass
    return False


def exe_path(dist, name):
    for cand in (os.path.join(dist, name + ".exe"),
                 os.path.join(dist, name, name + ".exe"),
                 os.path.join(dist, "dist", name + ".exe")):
        if os.path.isfile(cand):
            return cand
    return None


def run_and_check(cmd, cwd=None, timeout=900, label=""):
    print("  [pack] %s" % " ".join(os.path.basename(c) if os.sep in str(c) else str(c)
                                    for c in cmd))
    proc = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=timeout)
    if proc.returncode != 0:
        tail = (proc.stderr or proc.stdout or "")[-2500:]
        raise RuntimeError("%s failed (rc=%d):\n%s" % (label or cmd[0], proc.returncode, tail))
    return proc


def smoke_exe(exe, timeout=120):
    """Run the packed exe with --selftest; returns (ok, tail)."""
    try:
        proc = subprocess.run([exe, "--selftest"], capture_output=True, text=True,
                              timeout=timeout)
        return proc.returncode == 0, ((proc.stdout or "") + (proc.stderr or ""))[-600:]
    except subprocess.TimeoutExpired:
        return False, "timeout"
