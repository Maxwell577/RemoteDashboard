"""Bundle a protected dist with PyInstaller (--pack onefile|onedir).

The protected entry script plus its fortress_runtime package are frozen into
a standalone executable; the encrypted payloads stay encrypted at rest.
"""
import os
import shutil
import subprocess
import sys

from .common import dist_entry, needs_tkinter, run_and_check, smoke_exe, exe_path


def pack(args, opts):
    dist, entry, entry_path = dist_entry(args, opts)
    if not os.path.isfile(entry_path):
        raise RuntimeError("dist entry not found: %s" % entry_path)
    name = getattr(args, "name", None) or os.path.splitext(entry)[0]
    onefile = getattr(args, "pack", "onefile") == "onefile"
    build = os.path.join(dist, "_build_pyi")
    if os.path.isdir(build):
        shutil.rmtree(build)

    cmd = [sys.executable, "-m", "PyInstaller",
           "--noconfirm", "--clean",
           "--name", name,
           "--distpath", dist,
           "--workpath", os.path.join(build, "work"),
           "--specpath", os.path.join(build, "spec"),
           "--paths", dist,
           ]
    cmd.append("--onefile" if onefile else "--onedir")
    if os.name != "nt":
        pass  # console default on posix
    if needs_tkinter(getattr(args, "inputs", None)):
        cmd.append("--collect-all")
        cmd.append("tkinter")
    cmd.append(entry_path)

    run_and_check(cmd, cwd=dist, label="PyInstaller")
    exe = exe_path(dist, name)
    if not exe:
        raise RuntimeError("PyInstaller produced no exe for %r" % name)
    ok, tail = smoke_exe(exe)
    print("  [pack] PyInstaller exe: %s" % exe)
    print("  [pack] selftest: %s" % ("PASS" if ok else "FAIL"))
    if not ok:
        print("  [pack] tail: %s" % tail)
        raise RuntimeError("packed exe failed --selftest")
    if os.path.isdir(build):
        shutil.rmtree(build, ignore_errors=True)
    return exe
