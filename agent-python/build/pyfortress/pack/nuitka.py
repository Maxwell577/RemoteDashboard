"""Compile a protected dist to a native onefile exe with Nuitka (--nuitka).

Nuitka compiles the bootstrap files and the fortress_runtime package to C;
the ChaCha20-encrypted payloads are carried as embedded data and stay
encrypted at rest (decryption happens in memory at runtime only).
"""
import os
import shutil
import subprocess
import sys

from .common import dist_entry, needs_tkinter, run_and_check, smoke_exe


def pack(args, opts):
    dist, entry, entry_path = dist_entry(args, opts)
    if not os.path.isfile(entry_path):
        raise RuntimeError("dist entry not found: %s" % entry_path)
    name = (getattr(args, "name", None) or os.path.splitext(entry)[0]) + "_nk"
    build = os.path.join(dist, "_build_nk")
    if os.path.isdir(build):
        shutil.rmtree(build)
    os.makedirs(build, exist_ok=True)

    cmd = [sys.executable, "-m", "nuitka",
           "--mode=onefile",
           "--assume-yes-for-downloads",
           "--output-dir=%s" % build,
           "--output-filename=%s" % (name + ".exe" if os.name == "nt" else name),
           "--include-package=fortress_runtime",
           entry_path]
    if needs_tkinter(getattr(args, "inputs", None)):
        cmd.append("--enable-plugin=tk-inter")
        # the `import tkinter` lives inside encrypted payloads, invisible to
        # Nuitka's static analysis -> force-include the whole package
        cmd.append("--include-package=tkinter")

    run_and_check(cmd, cwd=dist, timeout=1800, label="Nuitka")
    exe = os.path.join(build, name + (".exe" if os.name == "nt" else ""))
    if not os.path.isfile(exe):
        # some versions put it next to the entry
        exe = os.path.join(dist, name + (".exe" if os.name == "nt" else ""))
    if not os.path.isfile(exe):
        raise RuntimeError("Nuitka produced no exe (looked in %s)" % build)
    final = os.path.join(dist, os.path.basename(exe))
    shutil.move(exe, final)
    ok, tail = smoke_exe(final)
    print("  [pack] Nuitka exe: %s" % final)
    print("  [pack] selftest: %s" % ("PASS" if ok else "FAIL"))
    if not ok:
        print("  [pack] tail: %s" % tail)
        raise RuntimeError("packed exe failed --selftest")
    shutil.rmtree(build, ignore_errors=True)
    return final
