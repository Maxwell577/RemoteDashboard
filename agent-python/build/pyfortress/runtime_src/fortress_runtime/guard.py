"""Anti-debug / anti-tamper guard with a generic failure message."""
import sys

_DEBUG_MODULES = (
    "pdb", "pydevd", "debugpy", "ptvsd", "dap", "rpdb", "ipdb",
    "pydevd_dap_sf", "_pydevd_bundle", "celery.contrib.rdb",
)


def anti_debug():
    for m in _DEBUG_MODULES:
        if m in sys.modules:
            _fail()
    try:
        if sys.gettrace() is not None:
            _fail()
        if sys.getprofile() is not None:
            _fail()
    except Exception:
        pass
    if sys.platform == "win32":
        try:
            import ctypes
            k32 = ctypes.windll.kernel32
            if k32.IsDebuggerPresent():
                _fail()
            dbg = ctypes.c_int(0)
            h = k32.GetCurrentProcess()
            if k32.CheckRemoteDebuggerPresent(h, ctypes.byref(dbg)) and dbg.value:
                _fail()
        except Exception:
            pass


def _fail():
    raise RuntimeError("unauthorized use of script")
