"""PyFortress interactive terminal menu - a guided, non-technical interface.

Open it with no arguments (python -m pyfortress) or: python -m pyfortress menu
"""
import hashlib
import os
import re
import subprocess
import sys
import time

from . import __version__
from . import cli as _cli


LINE = "=" * 62


def _print_banner():
    print()
    print(LINE)
    print("  PyFortress %s  -  protect your Python programs" % __version__)
    print("  encrypt | hide strings | rename | wrap | license | build .exe")
    print(LINE)


def _ask(prompt, default=""):
    suffix = " [%s]" % default if default != "" else ""
    val = input("%s%s: " % (prompt, suffix)).strip()
    return val or default


def _yes_no(prompt, default=False):
    hint = "[Y/n]" if default else "[y/N]"
    while True:
        try:
            val = _ask("%s %s" % (prompt, hint)).lower()
        except EOFError:
            return default
        if not val:
            return default
        if val in ("y", "yes"):
            return True
        if val in ("n", "no"):
            return False
        print("  Please answer y or n.")


def _choose(prompt, options, allow_zero=None):
    """Print numbered options, return the chosen 1-based index (0 = allow_zero)."""
    print()
    for i, label in enumerate(options, 1):
        print("   %d) %s" % (i, label))
    if allow_zero:
        print("   0) %s" % allow_zero)
    while True:
        val = _ask(prompt)
        if val.isdigit():
            n = int(val)
            if 1 <= n <= len(options):
                return n
            if n == 0 and allow_zero:
                return 0
        print("  Enter a number between 0 and %d." % len(options))


# ---------------------------------------------------------------- file pick

def _rel(p):
    try:
        return os.path.relpath(p)
    except ValueError:
        return p


def _list_python_files():
    """Candidate programs: .py files in the current folder + examples/."""
    found, seen = [], set()
    cwd = os.getcwd()

    def _add(path):
        ap = os.path.abspath(path)
        if ap not in seen and os.path.isfile(ap):
            seen.add(ap)
            found.append(ap)

    try:
        top = sorted(os.listdir(cwd))
    except OSError:
        top = []
    for fn in top:
        if fn.endswith(".py") and not fn.startswith("_"):
            _add(os.path.join(cwd, fn))
    ex_dir = os.path.join(cwd, "examples")
    if os.path.isdir(ex_dir):
        for dirpath, dirnames, filenames in os.walk(ex_dir):
            dirnames[:] = [d for d in dirnames
                           if d != "__pycache__" and not d.startswith("dist")]
            for fn in sorted(filenames):
                if fn.endswith(".py") and not fn.startswith("_"):
                    _add(os.path.join(dirpath, fn))
    return found


def pick_program():
    """Return (inputs, default_name). inputs is a list of paths."""
    files = _list_python_files()
    print("\nWhich program do you want to protect?")
    opts = ["%s   (in %s)" % (os.path.basename(p), _rel(os.path.dirname(p)) or ".")
            for p in files]
    n = _choose("Pick a number", opts, allow_zero="Enter a file or folder path myself")
    if n == 0:
        while True:
            raw = _ask("Path to a .py file (or a folder of .py files)").strip('"').strip("'")
            if os.path.isfile(raw) and raw.endswith(".py"):
                return [os.path.abspath(raw)], os.path.splitext(os.path.basename(raw))[0]
            if os.path.isdir(raw):
                return [os.path.abspath(raw)], os.path.basename(os.path.normpath(raw))
            print("  Not found - it must be a .py file or an existing folder. Try again.")
    p = files[n - 1]
    return [p], os.path.splitext(os.path.basename(p))[0]


# ------------------------------------------------------------------- levels

LEVELS = (
    ("Light",
     "encrypt the code only - fast; internal names stay visible"),
    ("Standard",
     "encrypt + hide all text strings + strip docstrings (recommended)"),
    ("Strong",
     "Standard + rename internal names + anti-debug + import armor"),
    ("Maximum",
     "Strong + wrap mode: each function re-encrypts itself when idle"),
)


def _level_args(idx):
    if idx == 1:
        return ["--obf-code", "1", "--no-mix-str", "--no-rft", "--no-antidebug"]
    if idx == 2:
        return ["--obf-code", "2", "--strip-docstrings", "--no-rft", "--no-antidebug"]
    if idx == 3:
        return ["--obf-code", "2", "--strip-docstrings", "--rft",
                "--antidebug", "--assert-import", "--assert-call"]
    return ["--obf-code", "2", "--strip-docstrings", "--rft",
            "--antidebug", "--assert-import", "--assert-call", "--wrap"]


def _have_module(name):
    try:
        __import__(name)
        return True
    except ImportError:
        return False


def _ensure_tool(modname, pipname, what):
    if _have_module(modname):
        return True
    print("\n  This option needs the '%s' package (%s)." % (pipname, what))
    if _yes_no("  Install it now with pip?", True):
        rc = subprocess.call([sys.executable, "-m", "pip", "install", pipname])
        if rc == 0 and _have_module(modname):
            print("  Installed.")
            return True
        print("  Installation did not succeed - continuing without the .exe.")
        return False
    print("  OK - skipping the .exe. (Install later with: pip install %s)" % pipname)
    return False


def _pc_fingerprint():
    hd = _cli._load_runtime_hdinfo()
    for vals in hd.all_fingerprints().values():
        for v in vals:
            return v
    return None


# ---------------------------------------------------------------- checksums

def _write_checksums(out_dir):
    lines = ["# PyFortress integrity receipt (SHA-256)",
             "# generated: %s" % time.strftime("%Y-%m-%d %H:%M:%S"),
             "# Compare these hashes later to detect any modification.", ""]
    count = 0
    for dirpath, dirnames, filenames in os.walk(out_dir):
        dirnames[:] = [d for d in dirnames if d != "__pycache__"]
        for fn in sorted(filenames):
            if fn == "checksums.txt":
                continue
            p = os.path.join(dirpath, fn)
            h = hashlib.sha256()
            with open(p, "rb") as f:
                for chunk in iter(lambda: f.read(65536), b""):
                    h.update(chunk)
            lines.append("%s  %s" % (h.hexdigest(), os.path.relpath(p, out_dir)))
            count += 1
    receipt = os.path.join(out_dir, "checksums.txt")
    with open(receipt, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    return receipt, count


# ------------------------------------------------------------------- wizard

def wizard():
    inputs, default_name = pick_program()
    is_dir = len(inputs) == 1 and os.path.isdir(inputs[0])

    print("\nHow strong should the protection be?")
    idx = _choose("Pick a level", ["%s - %s" % (nm, desc) for nm, desc in LEVELS])

    default_name = re.sub(r"[^A-Za-z0-9_-]", "_", default_name)
    name = _ask("Name for the protected program", default_name)
    name = re.sub(r"[^A-Za-z0-9_-]", "_", name) or default_name
    out_dir = "dist_" + name

    print("\nAlso build a ready-to-run .exe?")
    exe = _choose(
        "Pick an option",
        ["No - just the encrypted Python files (default)",
         "Yes - one single .exe file, easiest to share",
         "Yes - a folder with a .exe inside (starts a bit faster)",
         "Yes - single .exe built with Nuitka (slowest build)"])
    pack, nuitka = None, False
    if exe == 2:
        pack = "onefile" if _ensure_tool("PyInstaller", "pyinstaller", "builds .exe files") else None
    elif exe == 3:
        pack = "onedir" if _ensure_tool("PyInstaller", "pyinstaller", "builds .exe files") else None
    elif exe == 4:
        nuitka = _ensure_tool("nuitka", "nuitka", "compiles Python to a .exe")

    bind = None
    if _yes_no("\nLock the program to this PC? (it refuses to run on other machines)", False):
        fp = _pc_fingerprint()
        if fp:
            print("  This PC's fingerprint: %s" % fp)
            bind = fp
        else:
            print("  Could not read a fingerprint - skipping.")

    days = None
    if _yes_no("Add an expiry? (the program stops working N days after today)", False):
        while True:
            v = _ask("Number of days")
            if v.isdigit() and int(v) > 0:
                days = int(v)
                break
            print("  Enter a whole number, e.g. 30")

    receipt = _yes_no("Write a checksum receipt (a tamper-evident SHA-256 list)?", True)

    argv = ["protect"] + inputs
    if is_dir:
        argv.append("-r")
    argv += _level_args(idx)
    argv += ["-O", out_dir, "--name", name]
    if pack:
        argv += ["--pack", pack]
    if nuitka:
        argv.append("--nuitka")
    if bind:
        argv += ["-b", bind]
    if days:
        argv += ["-e", str(days)]

    print("\n" + "-" * 62)
    print("Building... (this can take a minute; .exe builds take longer)")
    print("-" * 62)
    ok = True
    try:
        _cli.main(argv)
    except SystemExit as e:
        ok = not e.code
    except Exception as exc:          # friendly message, no traceback wall
        print("\n  Build failed: %s" % exc)
        ok = False

    if not ok:
        print("\n  The build did not finish. Your original file was not modified.")
        return

    print("\n" + "*" * 62)
    print("  DONE! Your protected program is in the folder:  %s" % out_dir)
    print("*" * 62)
    entry = os.path.join(out_dir, name + ".py")
    if pack:
        exe_path = os.path.join(out_dir, name + ".exe")
        if not os.path.isfile(exe_path):
            for root, _dirs, files in os.walk(out_dir):
                for fn in files:
                    if fn.endswith(".exe"):
                        exe_path = os.path.join(root, fn)
                        break
        print("  To share it, copy this single file:  %s" % exe_path)
    else:
        print("  Keep the WHOLE folder together. Run the program with:")
        print("      python %s" % entry)
    print("  Your original file was not modified.")

    if receipt:
        try:
            path, n = _write_checksums(out_dir)
            print("  Integrity receipt: %s (%d file(s) hashed)" % (path, n))
        except OSError as exc:
            print("  Could not write the checksum receipt: %s" % exc)

    if _yes_no("Try running the protected program now?", False):
        if os.path.isfile(entry):
            print("  (close its window or press Ctrl+C there to come back)")
            subprocess.call([sys.executable, entry])


# ------------------------------------------------------------------- checks

def verify_flow():
    print("\nCheck a protected folder for tampering and key leaks.")
    print("NOTE: the check RUNS the protected program once - if it opens a")
    print("window, close it to continue.")
    dists = sorted(d for d in os.listdir(".") if os.path.isdir(d) and d.startswith("dist"))
    path = None
    if dists:
        n = _choose("Pick a folder", dists, allow_zero="Enter a folder path myself")
        path = dists[n - 1] if n else None
    if path is None:
        path = _ask("Folder to check (e.g. dist_snake)")
    if not os.path.isdir(path):
        print("  No such folder: %s" % path)
        return
    entry = None
    for fn in sorted(os.listdir(path)):
        if fn.endswith(".py"):
            entry = fn
            break
    if entry is None:
        print("  No .py entry file found in %s - exe-only folders can't be checked here." % path)
        return
    try:
        _cli.main(["verify", path, "--entry", entry])
    except SystemExit as e:
        if e.code:
            print("\n  The check FAILED - the folder may be tampered with or leaking.")
        else:
            print("\n  All checks passed.")


def fingerprint_flow():
    print("\nHardware fingerprints for this PC (used by 'lock to this PC'):")
    _cli.cmd_hdinfo(None)
    print("\nA program built with one of these values only runs on matching machines.")


def doctor_flow():
    print("\nToolchain status (what extras this PC can build):")
    _cli.cmd_doctor(None)


def help_flow():
    print("""
WHAT THE PROTECTION DOES
  Encryption        Your code is stored as scrambled data. The protected
                    folder runs it without ever containing readable source.
  Hide strings      Messages, labels and other text inside the code are
                    stored encrypted and decoded only while running.
  Rename (RFT)      Internal function/variable names are replaced with
                    random names, so the code stays hard to read.
  Wrap mode         Each function's code is decrypted only for the moment
                    it runs, then locked again.
  Anti-debug        Refuses to run under common debuggers.
  Import armor      Protected modules refuse imports of fake replacements.

EXTRAS THE WIZARD OFFERS
  .exe packaging    Share ONE file instead of a folder. PyInstaller is fast,
                    Nuitka compiles slower but produces a leaner exe.
  Lock to this PC   The program checks a hardware fingerprint and refuses
                    to run on any other computer.
  Expiry            The program stops working N days after it was built.
  Checksum receipt  A checksums.txt listing the SHA-256 hash of every
                    output file - re-hash later to prove nothing changed.

WHERE ARE MY FILES?
  Everything lands in a folder called dist_<name> next to this program.
  A file called .fortress-build.json in this folder holds the build keys -
  keep it private; it is what lets you issue license keys (advanced:
  python -m pyfortress key gen).

ADVANCED (COMMAND LINE)
  python -m pyfortress protect app.py -O dist --wrap --rft --antidebug
  python -m pyfortress verify dist --entry app.py
  python -m pyfortress protect app.py --native   (compile the runtime to
      native code with Cython - needs a C compiler)
  python -m pyfortress hdinfo | doctor | key gen | menu
""")


# --------------------------------------------------------------------- main

def run_menu():
    try:
        while True:
            _print_banner()
            print("  1) Protect a program (guided wizard)")
            print("  2) Check a protected folder (tamper + leak scan)")
            print("  3) Show this PC's fingerprint (for locking programs)")
            print("  4) Check my setup (which extras can I build?)")
            print("  5) Help - what do all these options mean?")
            print("  0) Exit")
            try:
                choice = _ask("\nChoose an option")
            except EOFError:
                print("\nBye!")
                return
            if choice in ("0", "q", "quit", "exit"):
                print("Bye!")
                return
            elif choice == "1":
                wizard()
            elif choice == "2":
                verify_flow()
            elif choice == "3":
                fingerprint_flow()
            elif choice == "4":
                doctor_flow()
            elif choice == "5":
                help_flow()
            elif choice == "":
                continue
            else:
                print("  Unknown option: %r" % choice)
    except KeyboardInterrupt:
        print("\nBye!")
