"""Remote command execution (exec).

Windows :  powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command <cmd>
           cmd.exe /d /s /c <cmd>
POSIX   :  /bin/bash -lc <cmd>   (effective shell reported as "bash")

shell="auto" tries PowerShell first and falls back to cmd on Windows; on POSIX
everything runs under bash. The reply ALWAYS reports the effective shell:
``{output, exitCode, durationMs, shell}`` per the v0.3 contract.

Hard limits: 25s timeout (process tree killed), 256KB output cap, output
decoded with ``errors="replace"`` so binary junk can never raise.
"""
from __future__ import annotations

import os
import shutil
import signal
import subprocess
import sys
import threading
import time
from typing import Dict, Optional

EXEC_TIMEOUT_S = 25
MAX_OUTPUT_BYTES = 256 * 1024

IS_WIN = sys.platform.startswith("win")


def _cap_output(text: str) -> str:
    """Trim to the byte cap on the utf-8 encoding (approximate is fine)."""
    if len(text.encode("utf-8", "replace")) <= MAX_OUTPUT_BYTES:
        return text
    # walk back until the encoded size fits
    lo, hi = 0, len(text)
    while lo < hi:
        mid = (lo + hi + 1) // 2
        if len(text[:mid].encode("utf-8", "replace")) <= MAX_OUTPUT_BYTES:
            lo = mid
        else:
            hi = mid - 1
    return text[:lo]


def _kill_tree(proc: subprocess.Popen) -> None:
    """Kill a process and (best effort) its children."""
    try:
        if IS_WIN:
            subprocess.run(
                ["taskkill", "/PID", str(proc.pid), "/T", "/F"],
                capture_output=True, timeout=5,
            )
        else:
            try:
                os.killpg(os.getpgid(proc.pid), signal.SIGKILL)  # process group
            except (ProcessLookupError, PermissionError, OSError):
                import psutil  # type: ignore
                parent = psutil.Process(proc.pid)
                for child in parent.children(recursive=True):
                    try:
                        child.kill()
                    except psutil.Error:
                        pass
                try:
                    parent.kill()
                except psutil.Error:
                    pass
    except Exception:  # noqa: BLE001 - best-effort cleanup, never raise
        try:
            proc.kill()
        except Exception:  # noqa: BLE001
            pass


def powershell_available() -> bool:
    """True when a PowerShell binary can be found on PATH."""
    for name in ("powershell.exe", "powershell", "pwsh"):
        if shutil.which(name):
            return True
    return False


def effective_shell(requested: Optional[str]) -> str:
    """Resolve "powershell" | "cmd" | "auto" (| anything else) -> actual runner.

    Returns "powershell", "cmd" (Windows) or "bash" (POSIX).
    """
    want = (requested or "powershell").lower()
    if IS_WIN:
        if want == "cmd":
            return "cmd"
        if want == "powershell":
            return "powershell" if powershell_available() else "cmd"
        # auto
        return "powershell" if powershell_available() else "cmd"
    # POSIX: honest bash execution regardless of the requested Windows shell
    return "bash"


def _run_win(command: str, shell: str) -> Dict[str, object]:
    if shell == "cmd":
        argv = ["cmd.exe", "/d", "/s", "/c", command]
    else:
        argv = ["powershell.exe", "-NoProfile", "-NonInteractive",
                "-ExecutionPolicy", "Bypass", "-Command", command]
    return _run_argv(argv, command)


def _run_posix(command: str) -> Dict[str, object]:
    bash = shutil.which("bash") or "/bin/bash"
    return _run_argv([bash, "-lc", command], command)


def _run_argv(argv: list, command: str) -> Dict[str, object]:
    started = time.monotonic()
    env = dict(os.environ)
    env.setdefault("SENTRA_AGENT", "1")  # visible marker for the invoked shell
    timed_out = False
    try:
        proc = subprocess.Popen(
            argv,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            stdin=subprocess.DEVNULL,
            env=env,
            start_new_session=not IS_WIN,  # own process group for clean tree kills
        )
    except OSError as exc:
        return {"output": f"[spawn error] {exc}", "exitCode": 1,
                "durationMs": int((time.monotonic() - started) * 1000),
                "shell": "cmd" if IS_WIN else "bash"}

    killer = threading.Timer(EXEC_TIMEOUT_S, _kill_tree, args=(proc,))
    killer.daemon = True
    killer.start()
    try:
        stdout, _ = proc.communicate(timeout=EXEC_TIMEOUT_S + 5)
        timed_out = killer.finished.is_set() if hasattr(killer, "finished") else False
    except subprocess.TimeoutExpired:
        timed_out = True
        try:
            stdout, _ = proc.communicate(timeout=2)
        except Exception:  # noqa: BLE001 - process is being torn down
            stdout = b""
    finally:
        killer.cancel()

    text = (stdout or b"").decode("utf-8", "replace").replace("\r\n", "\n")
    text = _cap_output(text)
    if timed_out:
        text = (text + f"\n[timeout after {EXEC_TIMEOUT_S}s — process terminated]").lstrip("\n")
    exit_code = 124 if timed_out else (proc.returncode if proc.returncode is not None else 0)
    return {
        "output": text,
        "exitCode": int(exit_code),
        "durationMs": int((time.monotonic() - started) * 1000),
        "shell": "cmd" if (IS_WIN and argv[0] == "cmd.exe") else ("powershell" if IS_WIN else "bash"),
    }


def run_command(command: str, shell: Optional[str] = None) -> Dict[str, object]:
    """Execute a remote command and return the v0.3 exec reply shape.

    ``shell`` accepts "powershell" | "cmd" | "auto" | "bash" (bash is treated
    like auto on POSIX). Never raises -- spawn errors are reported honestly.
    """
    cmd = str(command or "")
    if not cmd.strip():
        return {"output": "[error] empty command", "exitCode": 1,
                "durationMs": 0, "shell": effective_shell(shell)}

    eff = effective_shell(shell)
    if IS_WIN:
        return _run_win(cmd, eff)
    return _run_posix(cmd)
