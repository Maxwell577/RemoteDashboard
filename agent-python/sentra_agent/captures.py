"""Capture-source enumeration for register info (v0.3 CaptureCapabilities).

Enumerates EVERYTHING the agent could capture, honestly:
  * monitors   — via mss (per-monitor id/geometry), ``monitor:<n>``
  * cameras    — via OpenCV VideoCapture probe of indices 0..5, ``camera:<n>``
  * mics       — via sounddevice query_devices(kind="input"), ``mic:<n>``
  * shells     — Windows PowerShell / CMD detection (POSIX reports none: bash)
  * interfaces — via psutil (name, mac, ips, link state, speed, mtu)
  * notes      — honest limitation notes; every probe is import-guarded and
                 try/except wrapped so a missing/broken backend can never
                 crash registration (empty list + note instead).

``interfaces`` is an agent-side additive extension of the captures JSON so the
dashboard can show NICs without a protocol change; the frozen fields
(monitors/cameras/mics/shells/notes) keep their exact v0.3 shapes.
"""
from __future__ import annotations

import os
import shutil
import string
import sys
from typing import Any, Dict, List

IS_WIN = sys.platform.startswith("win")


def _note(notes: List[str], text: str) -> None:
    if text not in notes:
        notes.append(text)


# ─────────────────────────────────── monitors ───────────────────────────────

def _mss_monitors(notes: List[str]) -> List[Dict[str, Any]]:
    try:
        import mss  # type: ignore
    except Exception:  # noqa: BLE001 - optional dep
        _note(notes, "mss not installed — live screen / screen recording unavailable")
        return []
    try:
        with mss.mss() as sct:
            raw = list(sct.monitors)  # [0] = virtual all-monitors box
        out: List[Dict[str, Any]] = []
        for i, mon in enumerate(raw[1:], start=1):
            out.append({
                "id": f"monitor:{i - 1}",
                "name": f"Display {i}" + (" (primary)" if i == 1 else ""),
                "width": int(mon.get("width", 0)),
                "height": int(mon.get("height", 0)),
                "primary": i == 1,  # mss lists the primary monitor first on Windows
            })
        if not out:
            _note(notes, "no monitors detected by mss")
        return out
    except Exception as exc:  # noqa: BLE001 - headless X etc.
        _note(notes, f"monitor enumeration failed: {exc}")
        return []


# ─────────────────────────────────── cameras ────────────────────────────────

def _silence_cv2() -> None:
    """Best-effort silencing of OpenCV's noisy VIDEOIO probe logs."""
    try:
        import cv2  # type: ignore
    except Exception:  # noqa: BLE001
        return
    try:
        cv2.setLogLevel(0)
        return
    except Exception:  # noqa: BLE001
        pass
    try:
        cv2.utils.logging.setLogLevel(cv2.utils.logging.LOG_LEVEL_SILENT)
    except Exception:  # noqa: BLE001
        pass


def _opencv_cameras(notes: List[str]) -> List[Dict[str, Any]]:
    try:
        import cv2  # type: ignore
    except Exception:  # noqa: BLE001 - optional dep
        _note(notes, "opencv-python not installed — camera capture unavailable")
        return []
    _silence_cv2()
    cams: List[Dict[str, Any]] = []
    try:
        backend = getattr(cv2, "CAP_DSHOW", 0) if IS_WIN else getattr(cv2, "CAP_ANY", 0)
        for idx in range(6):  # probe 0..5 like the Node/dash convention
            cap = None
            try:
                cap = cv2.VideoCapture(idx, backend)
                ok = False
                if cap is not None and cap.isOpened():
                    ok, _frame = cap.read()
                if ok:
                    # best-effort friendly name from backend properties; most
                    # backends report 0.0 here, so fall back to "Camera <i>"
                    try:
                        w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
                        h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
                    except Exception:  # noqa: BLE001
                        w = h = 0
                    name = f"Camera {idx}" + (f" ({w}x{h})" if w and h else "")
                    cams.append({"id": f"camera:{idx}", "name": name})
            except Exception:  # noqa: BLE001 - single broken camera must not abort
                continue
            finally:
                try:
                    if cap is not None:
                        cap.release()
                except Exception:  # noqa: BLE001
                    pass
    except Exception as exc:  # noqa: BLE001
        _note(notes, f"camera enumeration failed: {exc}")
        return []
    if not cams:
        _note(notes, "no cameras detected (indices 0..5 probed)")
    return cams


# ──────────────────────────────────── mics ──────────────────────────────────

def _sounddevice_mics(notes: List[str]) -> List[Dict[str, Any]]:
    try:
        import sounddevice as sd  # type: ignore
    except Exception:  # noqa: BLE001 - optional dep (needs PortAudio)
        _note(notes, "sounddevice/PortAudio not installed — microphone capture unavailable")
        return []
    mics: List[Dict[str, Any]] = []
    try:
        devices = sd.query_devices()
        if isinstance(devices, dict):
            devices = [devices]
        for idx, dev in enumerate(devices):
            try:
                if int(dev.get("max_input_channels", 0)) <= 0:
                    continue
                name = str(dev.get("name", f"Input {idx}"))
                hostapi = ""
                try:
                    hostapi = str(sd.query_hostapis(dev.get("hostapi", 0))["name"])
                except Exception:  # noqa: BLE001
                    pass
                label = name + (f" [{hostapi}]" if hostapi else "")
                mics.append({"id": f"mic:{idx}", "name": label})
            except Exception:  # noqa: BLE001
                continue
        if not mics:
            _note(notes, "no input (microphone) devices found")
    except Exception as exc:  # noqa: BLE001 - PortAudio errors
        _note(notes, f"microphone enumeration failed: {exc}")
        return []
    return mics


# ─────────────────────────────────── shells ─────────────────────────────────

def _shells_and_notes(notes: List[str]) -> List[str]:
    if not IS_WIN:
        _note(notes, "POSIX agent executes remote commands with bash (shell param reported as \"bash\")")
        return []
    shells: List[str] = []
    if shutil.which("powershell.exe") or shutil.which("powershell") or shutil.which("pwsh"):
        shells.append("powershell")
    else:
        _note(notes, "PowerShell not found on PATH — exec falls back to cmd")
    if shutil.which("cmd.exe") or shutil.which("cmd"):
        shells.append("cmd")
    else:
        _note(notes, "cmd.exe not found on PATH")
    return shells


# ───────────────────────────────── interfaces ───────────────────────────────

def _interfaces(notes: List[str]) -> List[Dict[str, Any]]:
    """NICs: name, mac, ipv4/ipv6 list, link up/down, speed Mbps, mtu."""
    try:
        import psutil  # type: ignore
    except Exception:  # noqa: BLE001 - psutil is a core dep; still never crash
        _note(notes, "psutil not installed — interface enumeration unavailable")
        return []
    out: List[Dict[str, Any]] = []
    try:
        addrs = psutil.net_if_addrs()
        stats = psutil.net_if_stats()
        for name, addr_list in addrs.items():
            mac = ""
            ips: List[str] = []
            for addr in addr_list:
                fam = getattr(addr.family, "name", "") or str(addr.family)
                if "AF_LINK" in fam or "PACKET" in fam:
                    mac = addr.address
                elif "INET" in fam and "INET6" not in fam:
                    ips.append(addr.address)
                elif "INET6" in fam:
                    ips.append(addr.address.split("%")[0])
            st = stats.get(name)
            out.append({
                "name": name,
                "mac": mac,
                "ips": ips,
                "up": bool(st.isup) if st is not None else None,
                "speedMbps": int(getattr(st, "speed", 0) or 0) if st is not None else None,
                "mtu": int(getattr(st, "mtu", 0) or 0) if st is not None else None,
            })
        out.sort(key=lambda d: (not (d["up"] or False), d["name"]))
    except Exception as exc:  # noqa: BLE001
        _note(notes, f"interface enumeration failed: {exc}")
    return out


# ───────────────────────────────── windows drives ───────────────────────────

def windows_drives() -> List[str]:
    """Existing drive letters A:..Z: (Windows). Empty list on other OS."""
    if not IS_WIN:
        return ["/"]
    found: List[str] = []
    for letter in string.ascii_uppercase:
        drive = f"{letter}:\\"
        try:
            if os.path.exists(drive):
                found.append(drive)
        except OSError:  # noqa: PERF203
            continue
    return found or ["C:\\"]


# ─────────────────────────────────── public API ─────────────────────────────

def enumerate_captures() -> Dict[str, Any]:
    """Build the full CaptureCapabilities dict (+ interfaces) with notes."""
    notes: List[str] = []
    monitors = _mss_monitors(notes)
    cameras = _opencv_cameras(notes)
    mics = _sounddevice_mics(notes)
    shells = _shells_and_notes(notes)
    interfaces = _interfaces(notes)
    return {
        "monitors": monitors,
        "cameras": cameras,
        "mics": mics,
        "shells": shells,
        "notes": notes,
        "interfaces": interfaces,  # agent-side additive field (honest NIC report)
    }
