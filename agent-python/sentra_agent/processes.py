"""Process listing and control (ps:list / ps:action) via psutil.

ps:list  → { processes: [ProcessInfo], metrics }  (ProcessInfo: pid, name,
           cpuPercent, memoryMB, status, user, path)
ps:action { pid, action } → { ok, action, pid } for kill / suspend / resume.
"""
from __future__ import annotations

from typing import Any, Callable, Dict, List

MAX_PROCESSES = 300


def list_processes(metrics_provider: Callable[[], Dict[str, Any]]) -> Dict[str, Any]:
    """Enumerate the process table (real psutil data, sorted by memory)."""
    import psutil  # type: ignore

    procs: List[Dict[str, Any]] = []
    for p in psutil.process_iter():
        try:
            info = p.as_dict(attrs=["pid", "name", "cpu_percent", "memory_info",
                                    "status", "username", "exe"])
            mem = info.get("memory_info")
            procs.append({
                "pid": int(info.get("pid", 0)),
                "name": str(info.get("name") or "unknown"),
                "cpuPercent": round(float(info.get("cpu_percent") or 0.0), 1),
                "memoryMB": round((getattr(mem, "rss", 0) or 0) / (1024 * 1024), 1),
                "status": str(info.get("status") or "running"),
                "user": str(info.get("username") or ""),
                "path": str(info.get("exe") or ""),
            })
        except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
            continue
        except Exception:  # noqa: BLE001 - one weird process must not abort the listing
            continue
    procs.sort(key=lambda d: (d["memoryMB"], d["cpuPercent"]), reverse=True)
    procs = procs[:MAX_PROCESSES]
    return {"processes": procs, "metrics": metrics_provider()}


def process_action(pid: int, action: str) -> Dict[str, Any]:
    """kill / suspend / resume a process by pid (psutil; works on Windows)."""
    import psutil  # type: ignore

    act = str(action or "").lower()
    try:
        proc = psutil.Process(int(pid))
    except (psutil.NoSuchProcess, ValueError) as exc:
        raise ValueError(f"No such process {pid}") from exc
    except psutil.AccessDenied as exc:
        raise PermissionError(f"Access denied for pid {pid}") from exc

    if act == "kill":
        children = []
        try:
            children = proc.children(recursive=True)
        except psutil.Error:
            pass
        for child in children:
            try:
                child.kill()
            except psutil.Error:
                pass
        proc.kill()
    elif act == "suspend":
        proc.suspend()
    elif act == "resume":
        proc.resume()
    else:
        raise ValueError(f"Unknown process action '{action}'")
    return {"ok": True, "action": act, "pid": int(pid)}
