"""Agent configuration: defaults, validation, load/save, CLI/env merge.

Precedence (highest wins):
    CLI arguments  >  SENTRA_* environment variables  >  config.json  >  defaults

The config file lives next to ``agent.py`` by default (``config.json``).
NOTE: transparency behaviours (banner / toasts / tray / recording overlay) are
NOT configurable on purpose -- see :mod:`sentra_agent.transparency`.
"""
from __future__ import annotations

import json
import os
import sys
from typing import Any, Dict, List, Optional

# ── defaults ────────────────────────────────────────────────────────────────

DEFAULTS: Dict[str, Any] = {
    "hubUrl": "http://127.0.0.1:3003",
    "name": None,               # friendly name shown in the console / dashboard
    "tags": [],
    "heartbeatSec": 15,         # clamped 5..300
    "recordingsDir": "recordings",   # relative to the agent directory
    "maxRecordingMin": 60,      # hard cap for record:schedule durationSec
    "minFreeMB": 500,           # refuse recordings when free space is below this
    "fsRoot": None,             # None -> user home
    "deviceType": None,         # None -> auto (workstation on win/mac, server else)
    "agentId": None,            # None -> derived from hostname+mac
}

VALID_DEVICE_TYPES = {"workstation", "laptop", "server"}

_HEARTBEAT_MIN, _HEARTBEAT_MAX = 5, 300
_MAXREC_MIN, _MAXREC_MAX = 1, 720
_MINFREE_MIN = 50


class ConfigError(Exception):
    """Raised when a config file / value is invalid."""


def _clamp(n: float, lo: float, hi: float, fallback: float) -> float:
    try:
        v = float(n)
    except (TypeError, ValueError):
        return fallback
    if v != v:  # NaN
        return fallback
    return min(hi, max(lo, v))


def _as_tags(v: Any) -> List[str]:
    """Accept a list or a comma-separated string; return a clean list."""
    if isinstance(v, str):
        parts = v.split(",")
    elif isinstance(v, (list, tuple)):
        parts = [str(p) for p in v]
    else:
        return []
    return [t.strip() for t in parts if t.strip()][:16]


def normalize(raw: Dict[str, Any]) -> Dict[str, Any]:
    """Validate + normalize a raw config dict onto the DEFAULTS skeleton."""
    cfg = dict(DEFAULTS)
    if not isinstance(raw, dict):
        return cfg

    hub = str(raw.get("hubUrl") or DEFAULTS["hubUrl"]).strip()
    if not hub.startswith(("http://", "https://")):
        raise ConfigError(f"hubUrl must be an http(s) URL, got {hub!r}")
    cfg["hubUrl"] = hub.rstrip("/")

    name = raw.get("name") or raw.get("friendlyName")
    cfg["name"] = str(name).strip()[:80] if name else None

    cfg["tags"] = _as_tags(raw.get("tags"))

    cfg["heartbeatSec"] = int(_clamp(raw.get("heartbeatSec", DEFAULTS["heartbeatSec"]),
                                     _HEARTBEAT_MIN, _HEARTBEAT_MAX, DEFAULTS["heartbeatSec"]))
    cfg["maxRecordingMin"] = int(_clamp(raw.get("maxRecordingMin", DEFAULTS["maxRecordingMin"]),
                                        _MAXREC_MIN, _MAXREC_MAX, DEFAULTS["maxRecordingMin"]))
    cfg["minFreeMB"] = int(_clamp(raw.get("minFreeMB", DEFAULTS["minFreeMB"]),
                                  _MINFREE_MIN, 10_000_000, DEFAULTS["minFreeMB"]))

    rec_dir = raw.get("recordingsDir") or DEFAULTS["recordingsDir"]
    cfg["recordingsDir"] = str(rec_dir)

    fs_root = raw.get("fsRoot")
    cfg["fsRoot"] = str(fs_root) if fs_root else None

    dtype = raw.get("deviceType")
    if dtype and str(dtype).lower() in VALID_DEVICE_TYPES:
        cfg["deviceType"] = str(dtype).lower()

    aid = raw.get("agentId")
    cfg["agentId"] = str(aid).strip()[:64] if aid else None
    return cfg


def default_config_path() -> str:
    """config.json next to agent.py (or the package when frozen)."""
    base = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    return os.path.join(base, "config.json")


def load_file(path: str) -> Dict[str, Any]:
    """Load + validate a JSON config file (missing file -> {})."""
    try:
        with open(path, "r", encoding="utf-8") as fh:
            raw = json.load(fh)
    except FileNotFoundError:
        return {}
    except json.JSONDecodeError as exc:
        raise ConfigError(f"config file {path} is not valid JSON: {exc}") from exc
    return normalize(raw if isinstance(raw, dict) else {})


def load_config(cli_overrides: Optional[Dict[str, Any]] = None,
                config_path: Optional[str] = None) -> Dict[str, Any]:
    """Merge defaults <- config file <- env <- CLI overrides and return it."""
    path = config_path or default_config_path()
    cfg = load_file(path)

    env_map = {
        "hubUrl": os.environ.get("SENTRA_HUB"),
        "name": os.environ.get("SENTRA_NAME"),
        "tags": os.environ.get("SENTRA_TAGS"),
        "agentId": os.environ.get("SENTRA_AGENT_ID"),
    }
    for key, val in env_map.items():
        if val:
            cfg = {**cfg, **normalize({key: val})}

    if cli_overrides:
        cfg = {**cfg, **normalize(cli_overrides)}

    cfg["configPath"] = path
    return cfg


def save_config(cfg: Dict[str, Any], path: Optional[str] = None) -> str:
    """Persist the config (minus runtime-only keys) as JSON. Returns the path."""
    out = path or cfg.get("configPath") or default_config_path()
    payload = {k: v for k, v in cfg.items() if k in DEFAULTS and v is not None}
    with open(out, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, indent=2, sort_keys=True)
        fh.write("\n")
    return out


def resolve_recordings_dir(cfg: Dict[str, Any]) -> str:
    """Absolute recordings dir (created on demand, never crashes)."""
    d = cfg.get("recordingsDir") or "recordings"
    if not os.path.isabs(d):
        base = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        d = os.path.join(base, d)
    try:
        os.makedirs(d, exist_ok=True)
    except OSError:
        pass
    return d


def resolve_fs_root(cfg: Dict[str, Any]) -> str:
    """Absolute file-manager scope root."""
    if cfg.get("fsRoot"):
        return os.path.abspath(os.path.expanduser(str(cfg["fsRoot"])))
    return os.path.expanduser("~")


def auto_device_type() -> str:
    """Best-effort device type when none is configured."""
    if sys.platform.startswith("win"):
        return "workstation"
    if sys.platform == "darwin":
        return "laptop"
    return "server"
