"""PyFortress runtime: decrypts and executes protected bytecode in memory.

Copied into every protected build together with per-build _keys.py/_lic.py.
"""
import base64
import marshal
import sys
import types

from . import container as _container
from .chacha20 import hkdf as _hkdf

__version__ = "1.0.0"

_pf_runtime_marker__ = True  # used by restrict-mode frame checks

_STUB_CODE = compile(
    "def __pf_stub__(*__a, **__k):\n    raise RuntimeError('function not initialized')",
    "<fortress>", "exec",
).co_consts[0]

_WRAP_KEYS = {}       # modname -> (code_key, mack)
_PENDING_WRAPS = {}   # modname -> {real_name: b85 blob}


class FortressError(RuntimeError):
    pass


def _load_keys():
    # NOTE: must not be named `_keys` — the `_keys` submodule import would
    # shadow the function on the package after the first bootstrap call.
    from ._keys import get_keys
    return get_keys()


def _module_code_key(master, modname):
    return _hkdf(master, b"module:" + modname.encode("utf-8"))


def _module_str_key(master, modname):
    return _hkdf(master, b"strings:" + modname.encode("utf-8"))


def bootstrap(name, file, payload_b85):
    """Entry point called by every protected module/script."""
    master, mack = _load_keys()
    meta = _decrypt_meta(master, mack, payload_b85)
    modname = meta.get("modname") or name

    lic_required = bool(meta.get("license_required"))
    from . import license as _license
    _license.check_all(mack, lic_required)
    if meta.get("antidebug"):
        from . import guard
        guard.anti_debug()

    if name == "__main__":
        mod = sys.modules.get("__main__")
        if mod is None:
            mod = types.ModuleType(name)
            sys.modules[name] = mod
    elif name in sys.modules:
        mod = sys.modules[name]
    else:
        mod = types.ModuleType(name)
        sys.modules[name] = mod
    ns = mod.__dict__

    if meta.get("restricted"):
        _require_trusted_importer(name)

    ns["__fortress_trusted__"] = True
    ns["__fortress_protected__"] = modname
    ns["__ffs__"] = _make_ffs(_module_str_key(master, modname))
    ns["__fortress_unwrap__"] = _unwrap
    ns["__fortress_rewrap__"] = _rewrap
    if meta.get("assert_set"):
        ns["__assert_armored__"] = _make_assert(set(meta["assert_set"]))

    if meta.get("wrap_pairs"):
        # Register pending wraps BEFORE exec: module-level code may call a
        # wrapper during initial exec (e.g. `if __name__ == "__main__": main()`
        # runs before _install_wraps gets a chance below).
        _WRAP_KEYS[modname] = (_module_code_key(master, modname), mack)
        _PENDING_WRAPS[modname] = dict(meta.get("wrap_codes") or {})

    exec(meta["code"], ns)

    if meta.get("wrap_pairs"):
        _install_wraps(ns, meta, master, mack, modname)
    if meta.get("private"):
        _privatize(mod, meta.get("exports", ()), name)
    return mod


def _decrypt_meta(master, mack, payload_b85):
    if not payload_b85:
        raise FortressError("empty payload")
    try:
        blob = base64.b85decode(payload_b85.encode("ascii"))
    except Exception:
        raise FortressError("bad payload encoding")
    sep = blob.find(b"|")
    if sep < 0:
        raise FortressError("bad payload header")
    modname = blob[:sep].decode("utf-8", "replace")
    key = _module_code_key(master, modname)
    try:
        _flags, payload = _container.unpack(blob[sep + 1:], key, mack)
        meta = marshal.loads(payload)
    except _container.ContainerError:
        raise
    except Exception:
        raise FortressError("cannot load protected code (python version mismatch?)")
    meta.setdefault("modname", modname)
    return meta


def _require_trusted_importer(self_name=None):
    """Restrict mode: the module's own bootstrap frame is skipped; anything
    importing it must run inside another protected module. The entry script
    (run directly, no importer frames) is always allowed."""
    f = sys._getframe(2)
    depth = 0
    saw_self = False
    while f is not None and depth < 64:
        g = f.f_globals
        if g is not None:
            gname = g.get("__name__", "")
            if (g.get("_pf_runtime_marker__")
                    or gname.startswith("importlib")
                    or gname.startswith("_frozen_importlib")):
                f = f.f_back
                depth += 1
                continue
            if (not saw_self) and self_name is not None and gname == self_name:
                saw_self = True
                f = f.f_back
                depth += 1
                continue
            if g.get("__fortress_trusted__"):
                return
            raise FortressError("unauthorized use of script")
        f = f.f_back
        depth += 1
    if saw_self:
        return  # direct execution as the entry script
    raise FortressError("unauthorized use of script")


def _make_ffs(strkey):
    cache = {}

    def f(blob):
        v = cache.get(blob)
        if v is None:
            v = _container.dec_str(strkey, blob)
            cache[blob] = v
        return v

    return f


def _make_assert(protected_names):
    def a(obj):
        if getattr(obj, "__module__", None) not in protected_names:
            raise FortressError("unauthorized use of script")
        return obj

    return a


# ---------------- wrap mode ----------------

def _lazy_wrap_install(f):
    """First-use install for wrappers invoked before _install_wraps ran.

    Returns the real code object on success, None if this function is not a
    pending wrap (its real bytecode is simply still live).
    """
    modname = f.__globals__.get("__fortress_protected__")
    pending = _PENDING_WRAPS.get(modname) if modname else None
    blob = pending.get(f.__name__) if pending else None
    km = _WRAP_KEYS.get(modname) if (blob and modname) else None
    if not km:
        return None
    key, mack = km
    try:
        inner = base64.b85decode(blob.encode("ascii"))
        _flags, payload = _container.unpack(inner, key, mack)
        code = marshal.loads(payload)
    except Exception:
        return None
    f.__code__ = _STUB_CODE
    f._pf_real_code = code
    f._pf_lock = 0
    return code


def _unwrap(f):
    real_code = getattr(f, "_pf_real_code", None)
    if real_code is None:
        real_code = _lazy_wrap_install(f)
        if real_code is None:
            return f  # real code still live (initial exec): nothing to unlock
    lock = getattr(f, "_pf_lock", 0)
    f._pf_lock = lock + 1
    if lock == 0:
        f.__code__ = real_code
    return f


def _rewrap(f):
    if getattr(f, "_pf_real_code", None) is None:
        return  # not installed yet (initial exec): keep real code live
    lock = getattr(f, "_pf_lock", 1) - 1
    if lock <= 0:
        f._pf_lock = 0
        f.__code__ = _STUB_CODE
    else:
        f._pf_lock = lock


def _install_wraps(ns, meta, master, mack, modname):
    key = _module_code_key(master, modname)
    for real_name, wname in meta["wrap_pairs"]:
        real = ns.get(real_name)
        wrapper = ns.get(wname)
        blob = meta["wrap_codes"].get(real_name)
        if real is None or wrapper is None or blob is None:
            continue
        if not isinstance(real, types.FunctionType):
            continue
        try:
            inner_blob = base64.b85decode(blob.encode("ascii"))
            _flags, payload = _container.unpack(inner_blob, key, mack)
            real_code = marshal.loads(payload)
        except Exception:
            continue
        real.__code__ = _STUB_CODE
        real._pf_real_code = real_code
        real._pf_lock = 0
        wrapper.__defaults__ = real.__defaults__
        wrapper.__kwdefaults__ = real.__kwdefaults__
        wrapper.__doc__ = real.__doc__
        ns[real_name] = real


# ---------------- private mode ----------------

class _PrivateModule(types.ModuleType):
    def __getattribute__(self, item):
        v = types.ModuleType.__getattribute__(self, item)
        exports = _PrivateModule.__dict__.get("_pf_exports_", ())
        if item.startswith("__") or item in exports:
            return v
        f = sys._getframe(1)
        depth = 0
        while f is not None and depth < 64:
            g = f.f_globals
            if g is not None:
                gname = g.get("__name__", "")
                if (g.get("_pf_runtime_marker__")
                    or gname.startswith("importlib")
                    or gname.startswith("_frozen_importlib")):
                    f = f.f_back
                    depth += 1
                    continue
                if g.get("__fortress_trusted__"):
                    return v
                break
            f = f.f_back
            depth += 1
        raise AttributeError("module attribute is protected")


def _privatize(mod, exports, name):
    try:
        if type(mod) is types.ModuleType:
            mod.__class__ = _PrivateModule
    except Exception:
        return
    try:
        _PrivateModule._pf_exports_ = frozenset(exports)
    except Exception:
        pass
