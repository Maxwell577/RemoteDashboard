#!/usr/bin/env python3
"""SentraRMM Python agent — entry point.

A TRANSPARENT remote-management client for Windows (works cross-platform):
visible console banner, action toasts, tray icon and a mandatory on-screen
recording indicator. Speaks the v0.3 socket.io protocol of the SentraRMM hub.

Usage:
    python agent.py [options]

Options:
  --hub URL            Hub base url          (default http://127.0.0.1:3003)
  --name NAME          Friendly device name shown in the console
  --agent-id ID        Stable agent id       (default derived from hostname+mac)
  --tags a,b,c         Device tags
  --interval SEC       Heartbeat interval    (default 15, clamped 5..300)
  --recordings-dir DIR Where encrypted recordings are stored locally
  --type T             workstation | laptop | server
  --config FILE        JSON config file      (default ./config.json)
  --save-config        Persist the merged config to the config file and exit
  --print-info         Print device info + capture capabilities and exit
  --version            Print the agent version and exit
  -h, --help           This help

There is deliberately NO flag to hide the agent: transparency is enforced in
sentra_agent/transparency.py and cannot be disabled by config.
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import signal
import socket
import sys
import threading
import time
import uuid
from typing import Any, Dict, List, Optional

AGENT_VERSION = "0.3.0"
IS_WIN = sys.platform.startswith("win")

log = logging.getLogger("sentra.agent")


# ─────────────────────────────────── CLI ────────────────────────────────────

def parse_args(argv: Optional[List[str]] = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(prog="agent.py", description="SentraRMM transparent agent")
    p.add_argument("--hub", default=None)
    p.add_argument("--name", "--friendly-name", dest="name", default=None)
    p.add_argument("--agent-id", dest="agent_id", default=None)
    p.add_argument("--tags", default=None, help="comma separated")
    p.add_argument("--interval", type=int, default=None, help="heartbeat seconds")
    p.add_argument("--recordings-dir", dest="recordings_dir", default=None)
    p.add_argument("--type", dest="device_type", default=None,
                   choices=["workstation", "laptop", "server"])
    p.add_argument("--config", dest="config", default=None)
    p.add_argument("--save-config", dest="save_config", action="store_true")
    p.add_argument("--print-info", dest="print_info", action="store_true")
    p.add_argument("--version", action="store_true")
    return p.parse_args(argv)


def cli_overrides(args: argparse.Namespace) -> Dict[str, Any]:
    out: Dict[str, Any] = {}
    if args.hub:
        out["hubUrl"] = args.hub
    if args.name:
        out["name"] = args.name
    if args.agent_id:
        out["agentId"] = args.agent_id
    if args.tags:
        out["tags"] = args.tags
    if args.interval:
        out["heartbeatSec"] = args.interval
    if args.recordings_dir:
        out["recordingsDir"] = args.recordings_dir
    if args.device_type:
        out["deviceType"] = args.device_type
    return out


# ──────────────────────────────── device info ───────────────────────────────

def _linux_pretty_name() -> Optional[str]:
    try:
        with open("/etc/os-release", "r", encoding="utf-8") as fh:
            for line in fh:
                if line.startswith("PRETTY_NAME="):
                    return line.split("=", 1)[1].strip().strip('"') or None
    except OSError:
        pass
    return None


def _mac_address() -> str:
    try:
        import psutil  # type: ignore

        for _name, addrs in psutil.net_if_addrs().items():
            for addr in addrs:
                fam = getattr(addr.family, "name", "") or str(addr.family)
                if ("AF_LINK" in fam or "PACKET" in fam) and addr.address:
                    mac = addr.address.upper()
                    if mac.replace(":", "").replace("-", "").strip("0"):
                        return mac
    except Exception:  # noqa: BLE001 - fall back to uuid below
        pass
    node = uuid.getnode()
    return ":".join(f"{(node >> (8 * i)) & 0xFF:02x}" for i in reversed(range(6)))


def _local_ip() -> str:
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("8.8.8.8", 80))  # no traffic is sent; just picks a route
        ip = s.getsockname()[0]
    except OSError:
        ip = "127.0.0.1"
    finally:
        s.close()
    return ip


def _cpu_model() -> str:
    if not IS_WIN:
        try:
            with open("/proc/cpuinfo", "r", encoding="utf-8") as fh:
                for line in fh:
                    if line.startswith("model name"):
                        return line.split(":", 1)[1].strip()
        except OSError:
            pass
        try:
            import platform

            return platform.processor() or "Unknown CPU"
        except Exception:  # noqa: BLE001
            return "Unknown CPU"
    # Windows: a WMI spawn is not worth it at startup; keep it honest+cheap.
    return "Windows CPU"


def _total_memory_mb() -> int:
    try:
        import psutil  # type: ignore

        return int(psutil.virtual_memory().total / (1024 * 1024))
    except Exception:  # noqa: BLE001
        return 0


def build_agent_info(cfg: Dict[str, Any]) -> Dict[str, Any]:
    """AgentInfo shape from src/lib/types.ts (v0.3)."""
    hostname = socket.gethostname()
    os_name: str
    if IS_WIN:
        os_name = "Windows"
    elif sys.platform == "darwin":
        os_name = "macOS"
    else:
        os_name = _linux_pretty_name() or "Linux"

    from sentra_agent.config import auto_device_type

    agent_id = cfg.get("agentId") or (
        f"py-{hostname.lower().strip()}-{_mac_address().replace(':', '').lower()[:6]}"
    )
    agent_id = "".join(c if (c.isalnum() or c in "-_") else "-" for c in agent_id)
    return {
        "agentId": agent_id,
        "hostname": hostname,
        "friendlyName": cfg.get("name"),
        "osName": os_name,
        "osVersion": platform_release(),
        "osArch": platform_machine(),
        "platform": sys.platform,
        "cpuModel": _cpu_model(),
        "cpuCores": os.cpu_count() or 1,
        "totalMemoryMB": _total_memory_mb(),
        "localIp": _local_ip(),
        "macAddress": _mac_address(),
        "agentVersion": AGENT_VERSION,
        "deviceType": cfg.get("deviceType") or auto_device_type(),
        "tags": list(cfg.get("tags") or []),
    }


def platform_release() -> str:
    try:
        import platform

        return platform.release() or "unknown"
    except Exception:  # noqa: BLE001
        return "unknown"


def platform_machine() -> str:
    try:
        import platform

        return platform.machine() or "unknown"
    except Exception:  # noqa: BLE001
        return "unknown"


# ─────────────────────────────────── main ───────────────────────────────────

def main(argv: Optional[List[str]] = None) -> int:
    from sentra_agent import __version__
    from sentra_agent import config as cfgmod
    from sentra_agent.captures import enumerate_captures
    from sentra_agent.transparency import Transparency

    args = parse_args(argv)
    if args.version:
        print(f"SentraRMM Python agent v{__version__} (protocol v0.3)")
        return 0

    try:
        cfg = cfgmod.load_config(cli_overrides(args), config_path=args.config)
    except cfgmod.ConfigError as exc:
        print(f"[config error] {exc}", file=sys.stderr)
        return 2

    info = build_agent_info(cfg)
    captures = enumerate_captures()

    if args.print_info:
        print(json.dumps({**info, "captures": captures}, indent=2))
        return 0

    if args.save_config:
        path = cfgmod.save_config({k: v for k, v in cfg.items() if not k.startswith("_")},
                                  path=args.config)
        print(f"[config] saved to {path}")
        return 0

    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
        datefmt="%H:%M:%S",
    )

    # resolve runtime paths before wiring the managers
    cfg["_recordingsDirResolved"] = cfgmod.resolve_recordings_dir(cfg)
    cfg["_fsRootResolved"] = cfgmod.resolve_fs_root(cfg)

    transparency = Transparency()  # MANDATORY — no config can remove it
    transparency.banner(cfg.get("hubUrl", "?"), info["agentId"],
                        info.get("friendlyName") or info["hostname"], __version__)

    stop_event = threading.Event()

    def request_stop(signum: Any, _frame: Any) -> None:
        log.info("%s received — shutting down cleanly", signal.Signals(signum).name)
        stop_event.set()

    signal.signal(signal.SIGINT, request_stop)
    signal.signal(signal.SIGTERM, request_stop)
    try:  # Windows only: keep the console window close-aware too
        signal.signal(signal.SIGBREAK, request_stop)  # type: ignore[attr-defined]
    except (AttributeError, ValueError):
        pass

    def status_text() -> str:
        state = "RECORDING" if any(
            j.get("state") in ("armed", "recording")
            for j in recorder_jobs()
        ) else "idle (visible by design)"
        return f"SentraRMM agent v{__version__} — {state}"

    def recorder_jobs() -> List[Dict[str, Any]]:
        try:
            return hub.recorder.job_statuses()  # type: ignore[name-defined]
        except Exception:  # noqa: BLE001
            return []

    from sentra_agent.hublink import HubLink

    hub = HubLink(cfg, info, captures, transparency, stop_event)
    hub.start()
    transparency.start_tray(status_text)

    log.info("agent running — hub %s, heartbeat %ss, recordings dir %s, file scope %s",
             cfg.get("hubUrl"), cfg.get("heartbeatSec"),
             cfg["_recordingsDirResolved"], cfg["_fsRootResolved"])
    log.info("captures: monitors=%d cameras=%d mics=%d shells=%s interfaces=%d notes=%d",
             len(captures.get("monitors", [])), len(captures.get("cameras", [])),
             len(captures.get("mics", [])), captures.get("shells", []),
             len(captures.get("interfaces", [])), len(captures.get("notes", [])))
    for note in captures.get("notes", []):
        log.info("capture note: %s", note)

    try:
        while not stop_event.is_set():
            time.sleep(0.25)
    finally:
        log.info("stopping hub link, streams and transparency UI…")
        hub.stop()
        transparency.shutdown()
        log.info("goodbye")
    return 0


if __name__ == "__main__":
    sys.exit(main())
