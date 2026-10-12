"""Post-build verification: run the artifact, scan for plaintext leaks."""
import ast
import builtins
import json
import keyword
import os
import re
import subprocess
import sys

_IDENT_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{3,}$")
_COMMON = set(dir(builtins)) | set(keyword.kwlist) | {
    "main", "self", "args", "kwargs", "data", "name", "path", "file", "test",
    "__main__", "argv", "random", "status", "color", "reset", "seed", "turn",
}
# Binary artifacts (exe/pyd) embed huge chunks of the stdlib; only distinctive
# tokens count as leaks there. Bootstrap .py files keep the strict scan.
_BIN_MIN_IDENT = 8


def _source_tokens(inputs, excludes):
    """Identifiers + string literals from the ORIGINAL sources."""
    idents, strings = set(), set()
    for root in inputs:
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
                tree = ast.parse(open(path, "rb").read().decode("utf-8", "replace"))
            except SyntaxError:
                continue
            for n in ast.walk(tree):
                if isinstance(n, ast.Name) and _IDENT_RE.match(n.id):
                    idents.add(n.id)
                elif isinstance(n, (ast.FunctionDef, ast.ClassDef)) and _IDENT_RE.match(n.name):
                    idents.add(n.name)
                elif isinstance(n, ast.Constant) and isinstance(n.value, str):
                    v = n.value.strip()
                    if 5 <= len(v) <= 120 and not v.startswith(("http", "\n")) and "\n" not in v:
                        strings.add(v)
    return idents, strings


def run_artifact(path, args=(), timeout=60):
    apath = os.path.abspath(path)
    proc = subprocess.run([sys.executable, apath, *args], capture_output=True,
                          text=True, timeout=timeout, cwd=os.path.dirname(apath))
    return proc


def leak_scan(inputs, dist_dir):
    idents, strings = _source_tokens(inputs, ())
    # dunders are universal Python vocabulary, never a leak signal
    idents = {i for i in idents if i not in _COMMON
              and not (i.startswith("__") and i.endswith("__"))}
    leaked, checked = [], 0
    for dp, dns, fns in os.walk(dist_dir):
        dns[:] = [d for d in dns if d != "__pycache__" and d != "fortress_runtime"]
        for fn in fns:
            p = os.path.join(dp, fn)
            try:
                if fn.endswith((".py", ".pyd", ".exe", ".so")):
                    blob = open(p, "rb").read()
                else:
                    continue
            except OSError:
                continue
            text = blob.decode("utf-8", "ignore")
            is_py = fn.endswith(".py")
            toks = idents | set(s for s in strings if len(s) >= 6)
            if not is_py:
                toks = {t for t in idents if len(t) >= _BIN_MIN_IDENT}
            for tok in toks:
                checked += 1
                if tok in text:
                    leaked.append({"token": tok, "file": os.path.relpath(p, dist_dir)})
    return {"checked_tokens": checked, "leaks": leaked}


def verify(dist_dir, entry, inputs, selftest_args=()):
    entry_path = os.path.join(dist_dir, entry)
    report = {"entry": entry_path, "dist": os.path.abspath(dist_dir)}
    try:
        proc = run_artifact(entry_path, selftest_args)
        report["selftest"] = {
            "cmd": [sys.executable, entry_path, *selftest_args],
            "returncode": proc.returncode,
            "stdout_tail": proc.stdout[-800:],
            "stderr_tail": proc.stderr[-800:],
            "ok": proc.returncode == 0,
        }
    except Exception as e:
        report["selftest"] = {"ok": False, "error": repr(e)}
    report["leaks"] = leak_scan(inputs, dist_dir)
    report["ok"] = bool(report.get("selftest", {}).get("ok")) and not report["leaks"]["leaks"]
    out = os.path.join(dist_dir, "fortress-report.json")
    with open(out, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2)
    return report
