"""PyFortress command line interface."""
import argparse
import base64
import importlib.util
import json
import os
import subprocess
import sys

from . import __version__, keys as pfkeys, pipeline


def _load_runtime_hdinfo():
    p = os.path.join(pipeline.RUNTIME_SRC, "hdinfo.py")
    spec = importlib.util.spec_from_file_location("pf_hdinfo", p)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def cmd_hdinfo(_args):
    hd = _load_runtime_hdinfo()
    for cat, vals in hd.all_fingerprints().items():
        for v in vals:
            print("%-12s %s" % (cat, v))


def cmd_doctor(_args):
    print("python:      %s" % sys.version.split()[0])
    print("pyfortress:  %s" % __version__)
    for mod in ("Cython", "nuitka", "PyInstaller", "Crypto"):
        try:
            m = __import__(mod)
            print("%-12s installed" % mod)
        except ImportError:
            print("%-12s not installed (optional)" % mod)
    if sys.platform == "win32":
        vs = r"C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe"
        if os.path.isfile(vs):
            out = subprocess.run([vs, "-latest", "-products", "*",
                                  "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
                                  "-property", "installationPath"],
                                 capture_output=True, text=True)
            print("MSVC:        %s" % (out.stdout.strip() or "not found"))
        else:
            print("MSVC:        vswhere not found")
    print("protection:  all core features are pure stdlib - no license, no build limits")


def cmd_protect(args):
    opts = pipeline.BuildOptions(
        out=args.output, recursive=args.recursive, excludes=args.exclude,
        obf_module=args.obf_module, obf_code=args.obf_code,
        mix_str=args.mix_str, rft=args.rft, rft_excludes=args.rft_exclude,
        wrap=args.wrap, private=args.private, restrict=args.restrict,
        assert_import=args.assert_import, assert_call=args.assert_call,
        antidebug=args.antidebug, strip_docs=args.strip_docstrings,
        expired=pfkeys.parse_expire(args.expired),
        devices=args.bind_device,
        bind_data=_bind_data(args.bind_data),
        period=pfkeys.parse_period(args.period),
        outer=args.outer)
    print("PyFortress %s protecting %d input(s)..." % (__version__, len(args.inputs)))
    pipeline.protect(args.inputs, opts)
    if args.pack:
        from .pack import pyinstaller as pfpyi
        pfpyi.pack(args, opts)
    if args.nuitka:
        from .pack import nuitka as pfnk
        pfnk.pack(args, opts)
    if getattr(args, "native", False):
        from . import native
        native.compile_runtime(opts.out)


def _bind_data(spec):
    if spec is None:
        return None
    if spec.startswith("@"):
        with open(spec[1:], "rb") as f:
            return f.read().decode("utf-8", "replace")
    return spec


def _load_build_manifest():
    p = ".fortress-build.json"
    if not os.path.isfile(p):
        raise SystemExit("no .fortress-build.json here - run 'pyfortress protect' first")
    with open(p, encoding="utf-8") as f:
        return json.load(f)


def cmd_key(args):
    m = _load_build_manifest()
    mack = base64.b85decode(m["mack_b85"])
    blob = pfkeys.build_license_blob(
        mack,
        expires=pfkeys.parse_expire(args.expired),
        devices=args.bind_device,
        bind_data=_bind_data(args.bind_data),
        period=pfkeys.parse_period(args.period))
    if args.output == "pipe":
        sys.stdout.buffer.write(blob)
        return
    os.makedirs(args.output, exist_ok=True)
    path = os.path.join(args.output, "fortress.key")
    with open(path, "wb") as f:
        f.write(blob)
    print("outer key written:", path)


def cmd_verify(args):
    from . import verify as pfverify
    rep = pfverify.verify(args.dist, args.entry, args.inputs, tuple(args.selftest_args))
    ok = rep["ok"]
    print("selftest:    %s (rc=%s)" % (
        "PASS" if rep["selftest"].get("ok") else "FAIL",
        rep["selftest"].get("returncode")))
    leaks = rep["leaks"]["leaks"]
    print("leak scan:   %d token(s) checked, %d leak(s)" % (rep["leaks"]["checked_tokens"], len(leaks)))
    for l in leaks[:10]:
        print("  LEAK %-30r in %s" % (l["token"], l["file"]))
    print("report:      %s" % os.path.join(args.dist, "fortress-report.json"))
    print("OVERALL:     %s" % ("PASS" if ok else "FAIL"))
    sys.exit(0 if ok else 1)


def cmd_menu(_args):
    from .menu import run_menu
    run_menu()


def main(argv=None):
    ap = argparse.ArgumentParser(prog="pyfortress",
                                description="PyFortress - free Python code protection "
                                            "(encryption, renaming, wrap mode, licensing)")
    ap.add_argument("-v", "--version", action="version", version="PyFortress " + __version__)
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("protect", help="obfuscate + encrypt scripts/packages")
    p.add_argument("inputs", nargs="+")
    p.add_argument("-O", "--output", default="dist")
    p.add_argument("-r", "--recursive", action="store_true")
    p.add_argument("--exclude", action="append", default=[], metavar="PAT")
    p.add_argument("--obf-module", type=int, choices=(0, 1), default=1)
    p.add_argument("--obf-code", type=int, choices=(0, 1, 2), default=1)
    p.add_argument("--mix-str", action=argparse.BooleanOptionalAction, default=True)
    p.add_argument("--rft", action=argparse.BooleanOptionalAction, default=True)
    p.add_argument("--rft-exclude", action="append", default=[], metavar="NAME")
    p.add_argument("--wrap", action="store_true",
                   help="wrap mode: re-encrypt function code on exit")
    p.add_argument("--private", action="store_true")
    p.add_argument("--restrict", action="store_true")
    p.add_argument("--assert-import", action="store_true")
    p.add_argument("--assert-call", action="store_true")
    p.add_argument("--antidebug", action=argparse.BooleanOptionalAction, default=True)
    p.add_argument("--strip-docstrings", action="store_true")
    p.add_argument("-e", "--expired", metavar="DAYS|DATE")
    p.add_argument("-b", "--bind-device", action="append", default=[], metavar="DEV")
    p.add_argument("--bind-data", metavar="DATA|@FILE")
    p.add_argument("--period", metavar="30s|10m|2h")
    p.add_argument("--outer", action="store_true")
    p.add_argument("--pack", choices=("onefile", "onedir"), help="pack with PyInstaller")
    p.add_argument("--nuitka", action="store_true", help="build one-file exe with Nuitka")
    p.add_argument("--native", action="store_true", help="compile fortress_runtime to native .pyd with Cython")
    p.add_argument("--name", default=None, help="bundle name")
    p.set_defaults(func=cmd_protect)

    k = sub.add_parser("key", help="outer key management")
    kg = k.add_subparsers(dest="keycmd", required=True)
    kgen = kg.add_parser("gen", help="generate an outer runtime key")
    kgen.add_argument("-e", "--expired", metavar="DAYS|DATE")
    kgen.add_argument("-b", "--bind-device", action="append", default=[], metavar="DEV")
    kgen.add_argument("--bind-data", metavar="DATA|@FILE")
    kgen.add_argument("--period", metavar="30s|10m|2h")
    kgen.add_argument("-O", "--output", default="dist")
    kgen.set_defaults(func=cmd_key)

    h = sub.add_parser("hdinfo", help="show hardware fingerprints for --bind-device")
    h.set_defaults(func=cmd_hdinfo)

    d = sub.add_parser("doctor", help="show toolchain status")
    d.set_defaults(func=cmd_doctor)

    v = sub.add_parser("verify", help="run protected artifact + leak scan")
    v.add_argument("dist")
    v.add_argument("--entry", default=None)
    v.add_argument("inputs", nargs="*", help="original source paths for the leak scan")
    v.add_argument("--selftest-args", nargs="*", default=["--selftest"])
    v.set_defaults(func=cmd_verify)

    m = sub.add_parser("menu", help="interactive guided menu (recommended for beginners)")
    m.set_defaults(func=cmd_menu)

    args = ap.parse_args(argv)
    if args.cmd == "verify" and args.entry is None:
        for cand in ("snake.py", "main.py", "app.py"):
            if os.path.isfile(os.path.join(args.dist, cand)):
                args.entry = cand
                break
        if not args.entry:
            ap.error("could not find entry script in dist (use --entry)")
    args.func(args)


if __name__ == "__main__":
    main()
