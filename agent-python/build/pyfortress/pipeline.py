"""Build pipeline: discover -> analyze -> cross-rewrite -> transform -> containerize -> emit."""
import ast
import base64
import fnmatch
import json
import marshal
import os
import random
import shutil
import types

from . import container, keys as pfkeys
from .transforms import rft, mixstr, attrhide, asserts, wrapmode

RUNTIME_SRC = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                           "runtime_src", "fortress_runtime")

BOOTSTRAP_TEMPLATE = (
    "# Protected by PyFortress - do not edit\n"
    "from fortress_runtime import bootstrap as _pf_boot\n"
    "_pf_boot(__name__, __file__, %r)\n"
)


class ModuleSpec:
    def __init__(self, src, out_rel, modname, package, kind, is_entry=False):
        self.src = src
        self.out_rel = out_rel
        self.modname = modname
        self.package = package
        self.kind = kind          # 'script' | 'module' | 'pkg_init'
        self.is_entry = is_entry

    def __repr__(self):
        return "<%s %s>" % (self.kind, self.modname)


def _excluded(rel, patterns):
    for p in patterns:
        if fnmatch.fnmatch(rel.replace("\\\\", "/"), p) or fnmatch.fnmatch(os.path.basename(rel), p):
            return True
    return False


def discover(inputs, out_dir, recursive=False, excludes=()):
    """Map input files/dirs to ModuleSpecs with qualnames and dist-relative outputs."""
    specs = []
    out_abs = os.path.abspath(out_dir)
    for inp in inputs:
        inp = os.path.abspath(inp)
        if os.path.isfile(inp):
            if _excluded(os.path.basename(inp), excludes):
                continue
            base = os.path.basename(inp)
            stem = os.path.splitext(base)[0]
            specs.append(ModuleSpec(inp, base, stem, None, "script", is_entry=True))
        elif os.path.isdir(inp):
            root_name = os.path.basename(inp.rstrip("/\\"))
            base_dir = os.path.dirname(inp)
            for dirpath, dirnames, filenames in os.walk(inp):
                dirnames[:] = [d for d in dirnames
                               if d != "__pycache__" and not d.startswith(".")]
                if not recursive and os.path.abspath(dirpath) != inp:
                    # only first level when not recursive
                    depth_ok = os.path.dirname(os.path.abspath(dirpath)) == inp
                    if not depth_ok:
                        dirnames[:] = []
                for fn in sorted(filenames):
                    if not fn.endswith(".py"):
                        continue
                    full = os.path.join(dirpath, fn)
                    rel_inside = os.path.relpath(full, inp)
                    rel_out = os.path.join(root_name, rel_inside)
                    if _excluded(rel_out.replace(os.sep, "/"), excludes) or _excluded(fn, excludes):
                        continue
                    parts = rel_inside[:-3].replace(os.sep, ".").split(".")
                    modname = ".".join([root_name] + parts)
                    package = root_name if len(parts) == 1 else ".".join([root_name] + parts[:-1])
                    kind = "pkg_init" if parts[-1] == "__init__" else "module"
                    if kind == "pkg_init":
                        modname = package
                        package = package.rpartition(".")[0] or None
                    specs.append(ModuleSpec(full, rel_out, modname, package, kind))
        else:
            raise FileNotFoundError(inp)
    # unique by modname
    seen = {}
    for s in specs:
        seen.setdefault(s.modname, s)
    return list(seen.values())


def resolve_relative(spec, node):
    """Resolve a relative ImportFrom to an absolute module qualname."""
    if not node.level:
        return node.module
    pkg = spec.package or ""
    parts = pkg.split(".") if pkg else []
    if node.level - 1 > len(parts):
        return None
    base = parts[: len(parts) - (node.level - 1)]
    if node.module:
        base = base + node.module.split(".")
    return ".".join(base) or None


def strip_docstrings(tree):
    for n in ast.walk(tree):
        if isinstance(n, (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)):
            if n.body and isinstance(n.body[0], ast.Expr) and \
                    isinstance(n.body[0].value, ast.Constant) and isinstance(n.body[0].value.value, str):
                n.body = n.body[1:] or [ast.Pass()]
    ast.fix_missing_locations(tree)
    return tree


# ------------------------------------------------------------ build


class BuildOptions:
    def __init__(self, out="dist", recursive=False, excludes=(),
                 obf_module=1, obf_code=1, mix_str=True, rft=True, rft_excludes=(),
                 wrap=False, private=False, restrict=False, assert_import=False,
                 assert_call=False, antidebug=True, strip_docs=False,
                 expired=None, devices=(), bind_data=None, period=0, outer=False):
        self.out = out
        self.recursive = recursive
        self.excludes = list(excludes)
        self.obf_module = obf_module
        self.obf_code = obf_code
        self.mix_str = mix_str and obf_module == 1
        self.rft = rft
        self.rft_excludes = list(rft_excludes)
        self.wrap = wrap and obf_code >= 1
        self.private = private
        self.restrict = restrict
        self.assert_import = assert_import
        self.assert_call = assert_call
        self.antidebug = antidebug
        self.strip_docs = strip_docs
        self.expired = expired
        self.devices = list(devices)
        self.bind_data = bind_data
        self.period = period
        self.outer = outer


def protect(inputs, opts, verbose=True):
    specs = discover(inputs, opts.out, opts.recursive, opts.excludes)
    if not specs:
        raise RuntimeError("no Python scripts found")
    master, mack = pfkeys.new_secrets()
    lic_required = pfkeys.license_required(
        expires=opts.expired, devices=opts.devices, bind_data=opts.bind_data,
        period=opts.period, outer=opts.outer)

    out = opts.out
    os.makedirs(out, exist_ok=True)

    # 1. parse all modules
    trees = {}
    for s in specs:
        with open(s.src, "rb") as f:
            src = f.read()
        if src[:3] == b"\xef\xbb\xbf":
            src = src[3:]
        trees[s.modname] = ast.parse(src.decode("utf-8"), filename=s.src)

    # 2. analyze + decide rename maps for every module
    rng = random.Random()
    infos = {}
    for s in specs:
        a = rft.analyze(trees[s.modname])
        infos[s.modname] = rft.decide(a, s.modname, excludes=opts.rft_excludes, rng=rng)

    # 3. cross-module reference rewriting
    protected = set(trees)
    all_exports = {name: set() for name in protected}
    for s in specs:
        tree, exp = rft.cross_rewrite(trees[s.modname], s.modname, s.package, infos, protected)
        trees[s.modname] = tree
        for m, names in exp.items():
            all_exports[m] |= set(names)

    # 4. per-module transform + emit
    summary = []
    for s in specs:
        tree = trees[s.modname]
        info = infos[s.modname]
        n_renamed = sum(len(sc.renames) for sc in info.scope_by_node.values())

        if opts.rft:
            tree = rft.apply(tree, info)
        if opts.strip_docs:
            strip_docstrings(tree)

        str_key = pfkeys.module_str_key(master, s.modname)
        n_str = 0
        if opts.mix_str:
            tree, n_str = mixstr.apply(tree, str_key)
        if opts.obf_code >= 2 and opts.obf_module == 1:
            tree = attrhide.apply(tree, str_key)
        if opts.assert_import:
            tree = asserts.inject_import(tree, protected,
                                         resolve_from=lambda node, _s=s: resolve_relative(_s, node))
        if opts.assert_call:
            mod_funcs = {st.name for st in tree.body if isinstance(st, ast.FunctionDef)}
            tree = asserts.inject_call(tree, mod_funcs)

        wrap_pairs, wrap_codes = [], {}
        if opts.wrap:
            tree, wrap_pairs = wrapmode.apply(tree, s.modname)

        out_path = os.path.join(out, s.out_rel)
        os.makedirs(os.path.dirname(out_path) or out, exist_ok=True)

        if opts.obf_module == 0:
            with open(out_path, "w", encoding="utf-8") as f:
                f.write("# Protected by PyFortress (source mode)\n")
                f.write(ast.unparse(tree))
            emitted = "source"
        else:
            code = compile(tree, s.src, "exec")
            if wrap_pairs:
                real_codes = {}
                for c in code.co_consts:
                    if isinstance(c, types.CodeType):
                        for real, wname in wrap_pairs:
                            if c.co_name == real:
                                real_codes[real] = c
                for real, _w in wrap_pairs:
                    rc = real_codes.get(real)
                    if rc is not None:
                        blob = container.pack(marshal.dumps(rc),
                                              pfkeys.module_code_key(master, s.modname), mack)
                        wrap_codes[real] = base64.b85encode(blob).decode("ascii")
                wrap_pairs = [(r, w) for r, w in wrap_pairs if r in wrap_codes]
            meta = {
                "modname": s.modname,
                "code": code,
                "private": bool(opts.private),
                "restricted": bool(opts.restrict) and s.kind != "pkg_init",
                "exports": sorted(all_exports.get(s.modname, ())),
                "antidebug": bool(opts.antidebug),
                "license_required": bool(lic_required),
                "assert_set": sorted(protected) if (opts.assert_import or opts.assert_call) else None,
                "wrap_pairs": wrap_pairs,
                "wrap_codes": wrap_codes,
            }
            payload = marshal.dumps(meta)
            blob = container.pack(payload, pfkeys.module_code_key(master, s.modname), mack)
            payload_b85 = base64.b85encode(
                s.modname.encode("utf-8") + b"|" + blob).decode("ascii")
            with open(out_path, "w", encoding="utf-8", newline="\n") as f:
                f.write(BOOTSTRAP_TEMPLATE % payload_b85)
            emitted = "encrypted"

        summary.append({"module": s.modname, "out": out_path, "mode": emitted,
                        "renamed": n_renamed, "strings": n_str, "wrapped": len(wrap_pairs)})
        if verbose:
            print("  %-28s %-9s renamed=%-4d strings=%-4d wrapped=%d"
                  % (s.modname, emitted, n_renamed, n_str, len(wrap_pairs)))

    # 5. emit runtime package
    rt_dir = os.path.join(out, "fortress_runtime")
    if os.path.isdir(rt_dir):
        shutil.rmtree(rt_dir)
    os.makedirs(rt_dir)
    for fn in ("__init__.py", "chacha20.py", "container.py", "guard.py",
               "hdinfo.py", "license.py"):
        shutil.copy2(os.path.join(RUNTIME_SRC, fn), os.path.join(rt_dir, fn))
    with open(os.path.join(rt_dir, "_keys.py"), "w", encoding="utf-8") as f:
        f.write(pfkeys.render_keys_module(master, mack))

    lic_blob = pfkeys.build_license_blob(
        mack, expires=opts.expired, devices=opts.devices,
        bind_data=opts.bind_data, period=opts.period)
    if opts.outer:
        with open(os.path.join(out, "fortress.key"), "wb") as f:
            f.write(lic_blob)
        with open(os.path.join(rt_dir, "_lic.py"), "w", encoding="utf-8") as f:
            f.write('_LIC = ""\n')
    else:
        with open(os.path.join(rt_dir, "_lic.py"), "w", encoding="utf-8") as f:
            f.write("_LIC = %r\n" % base64.b85encode(lic_blob).decode("ascii"))

    # 6. build manifest for `key gen` / shared runtime regeneration
    with open(os.path.join(".fortress-build.json"), "w", encoding="utf-8") as f:
        json.dump({
            "master_b85": base64.b85encode(master).decode("ascii"),
            "mack_b85": base64.b85encode(mack).decode("ascii"),
            "modules": [s.modname for s in specs],
        }, f)

    if verbose:
        print("protected %d module(s) -> %s" % (len(specs), os.path.abspath(out)))
    return summary
