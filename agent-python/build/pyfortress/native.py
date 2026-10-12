"""Native tier (--native): Cython-compile the shipped runtime to .pyd.

The fortress_runtime package
(embedded keys, container crypto, license checks) is compiled to native
extensions with Cython + the platform C toolchain, and the .py sources are
removed from the dist. Bytecode-level decompilation of the runtime/keys no
longer applies; only native reverse engineering does.
"""
import glob
import os
import shutil
import subprocess
import sys

_RUNTIME_FILES = ("chacha20.py", "container.py", "guard.py",
                  "hdinfo.py", "license.py", "_keys.py", "_lic.py")

_SETUP_PY = """\
from setuptools import Extension, setup
from Cython.Build import cythonize
setup(
    name="fortress_runtime_native",
    ext_modules=cythonize(
        [Extension("fortress_runtime", ["fortress_runtime/__init__.py"])],
        language_level=3),
)
"""


def _run(cmd, cwd, timeout=600):
    proc = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, timeout=timeout)
    if proc.returncode != 0:
        tail = (proc.stderr or proc.stdout or "")[-2000:]
        raise RuntimeError("%s failed:\n%s" % (cmd[0:4], tail))
    return proc


def _build_init(build):
    """Package __init__ needs PyInit_fortress_runtime -> explicit Extension."""
    os.makedirs(os.path.join(build, "fortress_runtime"), exist_ok=True)
    shutil.copy2(os.path.join(build, "__init__.py"),
                 os.path.join(build, "fortress_runtime", "__init__.py"))
    with open(os.path.join(build, "setup.py"), "w", encoding="utf-8") as f:
        f.write(_SETUP_PY)
    _run([sys.executable, "setup.py", "build_ext", "--inplace"], build, timeout=900)
    pyds = glob.glob(os.path.join(build, "fortress_runtime*.pyd"))
    if not pyds:
        raise RuntimeError("native build produced no __init__ pyd")
    return pyds[0]


def compile_runtime(dist, keep_c=False):
    dist = os.path.abspath(dist)
    rt = os.path.join(dist, "fortress_runtime")
    if not os.path.isdir(rt):
        raise RuntimeError("no fortress_runtime package in %s" % dist)
    try:
        import Cython  # noqa: F401
    except ImportError:
        raise RuntimeError("Cython is not installed (pip install cython)")

    build = os.path.join(dist, "_native_build")
    if os.path.isdir(build):
        shutil.rmtree(build)
    os.makedirs(build)

    for fn in _RUNTIME_FILES:
        src = os.path.join(rt, fn)
        if not os.path.isfile(src):
            continue
        shutil.copy2(src, os.path.join(build, fn))
        _run([sys.executable, "-m", "Cython.Build.Cythonize", "-i", "--inplace",
              os.path.join(build, fn)], build)
        pyds = glob.glob(os.path.join(build, os.path.splitext(fn)[0] + "*.pyd"))
        if not pyds:
            raise RuntimeError("native build produced no pyd for %s" % fn)
        base = os.path.splitext(fn)[0]
        shutil.copy2(pyds[0], os.path.join(rt, base + ".pyd"))
        os.remove(src)                      # remove the readable source
        if os.path.isfile(src + "c"):
            os.remove(src + "c")

    # package __init__: plain __init__.pyd would export PyInit___init__;
    # build it under its real package name instead.
    shutil.copy2(os.path.join(rt, "__init__.py"), os.path.join(build, "__init__.py"))
    init_pyd = _build_init(build)
    shutil.copy2(init_pyd, os.path.join(rt, "__init__.pyd"))
    os.remove(os.path.join(rt, "__init__.py"))
    if os.path.isfile(os.path.join(rt, "__init__.pyc")):
        os.remove(os.path.join(rt, "__init__.pyc"))

    if not keep_c:
        shutil.rmtree(build, ignore_errors=True)
    print("  [native] fortress_runtime compiled to native extensions "
          "(.pyd); sources removed")
