"""MANDATORY user-facing transparency features.

THIS MODULE IS THE TRANSPARENCY CONTRACT OF THE SENTRARM AGENT AND IT IS
NON-OPTIONAL. There is deliberately NO config switch, CLI flag or environment
variable that can disable any of these behaviours:

1.  Console banner at startup announcing that the agent is visible and managed.
2.  A toast/notification on EVERY remote action (exec, file ops, streams,
    recordings) so the device user sees what the operator is doing.
3.  A persistent on-screen RECORDING OVERLAY (topmost, borderless, rose/red
    frame + "● Recording — SentraRMM managed session") shown for the whole
    duration of any recording. It cannot be closed while recording; it is
    withdrawn automatically when the recording ends.
4.  A tray icon (green dot = idle, red dot = recording) with tooltip and an
    About/Status menu.

On headless machines / desktops without a notification daemon every one of
these degrades to explicit console logging instead of silently disappearing --
the console channel is always active. ``build/build_encrypted.py`` embeds the
sha256 of this file and refuses to build when it is missing or modified, so the
protection pipeline cannot ship an agent without these features.
"""
from __future__ import annotations

import logging
import queue
import sys
import threading
import time
from typing import Any, Callable, Optional

log = logging.getLogger("sentra.transparency")

#: Sentinel enforced at import time. If some patched build flips this to False
#: the agent refuses to start (see :func:`assert_enforced`).
TRANSPARENCY_ENFORCED = True

ROSE = "#e11d48"      # rose-600 recording border
GREEN = "#22c55e"     # idle tray dot
RED = "#ef4444"       # recording tray dot

IS_WIN = sys.platform.startswith("win")


def assert_enforced() -> None:
    """Raise if the transparency module was tampered with."""
    if not TRANSPARENCY_ENFORCED:  # pragma: no cover - tamper guard
        raise RuntimeError(
            "TRANSPARENCY_ENFORCED was disabled — SentraRMM refuses to run an "
            "invisible agent. Restore sentra_agent/transparency.py."
        )


assert_enforced()


def _utc_hms() -> str:
    return time.strftime("%H:%M:%S")


# ───────────────────────────────── console banner ───────────────────────────

def print_banner(hub_url: str, agent_id: str, friendly_name: str, version: str) -> None:
    """Startup banner (always printed, cannot be silenced)."""
    name = friendly_name or "(unnamed device)"
    print("=" * 66)
    print("  SentraRMM agent — THIS AGENT IS VISIBLE BY DESIGN")
    print("  It registers on the operator console and announces every")
    print("  remote action on this screen. The device user can stop it")
    print("  at any time with Ctrl+C in this console window.")
    print("=" * 66)
    print(f"  version   : v{version}")
    print(f"  device    : {name}")
    print(f"  agentId   : {agent_id}")
    print(f"  hub       : {hub_url}")
    print("  recording : shows a red on-screen banner while active")
    print("=" * 66)
    sys.stdout.flush()


# ─────────────────────────────────── toasts ────────────────────────────────

class Notifier:
    """Desktop notifications with a guaranteed console fallback."""

    def __init__(self) -> None:
        self._plyer: Any = None
        try:  # guarded: plyer is optional at runtime, the console never is
            from plyer import notification  # type: ignore

            self._plyer = notification
        except Exception as exc:  # noqa: BLE001 - headless / not installed
            log.info("plyer notifications unavailable (%s) — using console toasts", exc)

    def notify(self, title: str, message: str) -> None:
        """Send a desktop toast; always mirror it to the console."""
        line = f"[toast {_utc_hms()}] {title} — {message}"
        print(line)
        sys.stdout.flush()
        if self._plyer is None:
            return
        try:
            self._plyer.notify(
                title=title[:64], message=message[:240],
                app_name="SentraRMM agent", timeout=6,
            )
        except Exception as exc:  # noqa: BLE001 - no DE / no dbus, etc.
            log.info("toast backend failed (%s) — console toast only", exc)

    # semantic helpers used across the agent ---------------------------------

    def remote_action(self, kind: str, detail: str) -> None:
        """Announce a remote operator action (exec / fs / stream / record)."""
        titles = {
            "exec": "Remote command",
            "fs": "File operation",
            "stream": "Live stream started",
            "record": "Recording notice",
        }
        self.notify(titles.get(kind, "Remote action"), detail)

    def recording_armed(self, label: str, duration_sec: int, notice_text: Optional[str]) -> None:
        msg = notice_text or "A managed recording is about to start on this device."
        msg += f" ({label or 'recording'}, {duration_sec}s)"
        self.notify("Recording scheduled — SentraRMM", msg)

    def recording_started(self, label: str) -> None:
        self.notify("Recording started", "A red banner on screen marks the managed session."
                    + (f" ({label})" if label else ""))

    def recording_stopped(self, label: str, state: str) -> None:
        self.notify(f"Recording {state}", f"Managed recording ended." + (f" ({label})" if label else ""))


# ────────────────────────────── recording overlay ───────────────────────────

class RecordingOverlay:
    """Topmost borderless '● Recording' banner shown while recording.

    Runs tkinter in a dedicated thread. Every UI call is marshalled onto that
    thread through a queue, so it is safe to start()/stop() from anywhere. If
    tkinter or a display is unavailable the overlay degrades to console logs.
    """

    def __init__(self) -> None:
        self._thread: Optional[threading.Thread] = None
        self._calls: "queue.Queue[Callable[[Any], None]]" = queue.Queue()
        self._root: Any = None            # lives in _thread only
        self._available: Optional[bool] = None
        self._count = 0
        self._lock = threading.Lock()

    # -- internal ----------------------------------------------------------

    def _thread_main(self) -> None:
        try:
            import tkinter as tk  # type: ignore

            root = tk.Tk()
            root.overrideredirect(True)                 # borderless, unclosable
            root.attributes("-topmost", True)
            root.configure(bg=ROSE)
            root.withdraw()                             # hidden until start()
            root.protocol("WM_DELETE_WINDOW", lambda: None)  # ignore close

            pad = tk.Frame(root, bg=ROSE, padx=14, pady=10)
            pad.pack(fill="both", expand=True)
            dot = tk.Label(pad, text="●", fg="white", bg=ROSE,
                           font=("Segoe UI", 14, "bold"))
            dot.pack(side="left")
            label = tk.Label(
                pad, text="  Recording — SentraRMM managed session",
                fg="white", bg=ROSE, font=("Segoe UI", 12, "bold"),
            )
            label.pack(side="left")
            root.update_idletasks()

            sw = root.winfo_screenwidth()
            sh = root.winfo_screenheight()
            w = max(380, min(520, int(sw * 0.32)))
            h = 56
            root.geometry(f"{w}x{h}+{sw - w - 24}+{sh - h - 48}")

            blink = {"on": True}

            def toggle() -> None:
                blink["on"] = not blink["on"]
                dot.config(text="●" if blink["on"] else " ")
                root.after(900, toggle)

            root.after(900, toggle)
            self._root = root
            self._available = True

            def pump() -> None:
                while True:
                    try:
                        fn = self._calls.get_nowait()
                    except queue.Empty:
                        break
                    try:
                        fn(root)
                    except Exception:  # noqa: BLE001 - UI best effort
                        pass
                root.after(80, pump)

            root.after(80, pump)
            root.mainloop()
        except Exception as exc:  # noqa: BLE001 - headless / no tkinter / no DISPLAY
            self._available = False
            log.info("recording overlay unavailable (%s) — console indicator only", exc)

    # -- public (thread-safe) ----------------------------------------------

    def start(self, label: Optional[str] = None) -> None:
        """Show the overlay (spawns the UI thread on first use)."""
        with self._lock:
            self._count += 1
        if self._thread is None:
            self._thread = threading.Thread(
                target=self._thread_main, name="sentra-overlay", daemon=True
            )
            self._thread.start()
            time.sleep(0.15)  # give the thread a beat to initialise

        def apply(root: Any) -> None:
            text = "  Recording — SentraRMM managed session"
            if label:
                text += f"  ({label})"
            try:
                for w in root.winfo_children():
                    for c in w.winfo_children():
                        if c.winfo_class() == "Label" and c.cget("text").startswith("  Recording"):
                            c.config(text=text)
            except Exception:  # noqa: BLE001
                pass
            root.deiconify()
            root.attributes("-topmost", True)
            root.lift()

        self._calls.put(apply)
        print(f"[overlay {_utc_hms()}] RECORDING indicator shown on screen"
              + (f" ({label})" if label else ""))
        sys.stdout.flush()

    def stop(self) -> None:
        """Hide the overlay (kept warm for the next recording)."""
        with self._lock:
            self._count = max(0, self._count - 1)
            if self._count > 0:
                return  # another recording is still active

        def apply(root: Any) -> None:
            root.withdraw()

        self._calls.put(apply)
        print(f"[overlay {_utc_hms()}] RECORDING indicator hidden")
        sys.stdout.flush()

    def shutdown(self) -> None:
        """Tear the UI thread down for process exit."""
        def apply(root: Any) -> None:
            try:
                root.quit()
            except Exception:  # noqa: BLE001
                pass

        self._calls.put(apply)
        if self._thread is not None:
            self._thread.join(timeout=2.0)
            self._thread = None


# ─────────────────────────────────── tray ───────────────────────────────────

def _dot_image(color: str) -> Any:
    """64x64 colored dot as a PIL image (guarded import)."""
    from PIL import Image, ImageDraw  # type: ignore

    img = Image.new("RGBA", (64, 64), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    draw.ellipse((10, 10, 54, 54), fill=color)
    draw.ellipse((16, 16, 48, 48), outline=(255, 255, 255, 200), width=3)
    return img


class TrayIcon:
    """System tray icon: green dot idle, red dot recording. Menu: About/Status.

    pystray needs a tray host (Windows shell / appindicator). Without one it
    degrades to console logging — the console channel is always on.
    """

    def __init__(self, status_provider: Callable[[], str]) -> None:
        self._status = status_provider
        self._icon: Any = None
        self._ok = False
        self._thread: Optional[threading.Thread] = None

    def start(self) -> None:
        try:
            import pystray  # type: ignore

            menu = pystray.Menu(
                pystray.MenuItem("About SentraRMM", self._about, default=True),
                pystray.MenuItem("Status", self._status_item),
            )
            icon = pystray.Icon(
                "sentrarmm", _dot_image(GREEN),
                "SentraRMM agent — visible by design", menu,
            )
            self._icon = icon
            self._thread = threading.Thread(target=icon.run, name="sentra-tray", daemon=True)
            self._thread.start()
            self._ok = True
        except Exception as exc:  # noqa: BLE001 - headless / missing Pillow/pystray
            log.info("tray icon unavailable (%s) — console status logging only", exc)

    def set_recording(self, recording: bool) -> None:
        """Swap the tray dot green↔red (no-op when the tray is unavailable)."""
        if not self._ok or self._icon is None:
            return
        try:
            self._icon.icon = _dot_image(RED if recording else GREEN)
            self._icon.title = (
                "SentraRMM agent — RECORDING" if recording
                else "SentraRMM agent — visible by design"
            )
        except Exception as exc:  # noqa: BLE001
            log.info("tray update failed: %s", exc)

    # menu callbacks (pystray thread) ---------------------------------------

    def _about(self, icon: Any = None, item: Any = None) -> None:
        Notifier().notify(
            "SentraRMM agent",
            "Transparent remote-management agent. This icon shows when the "
            "device is managed; recordings show a red banner on screen.",
        )

    def _status_item(self, icon: Any = None, item: Any = None) -> None:
        Notifier().notify("SentraRMM status", self._status())

    def shutdown(self) -> None:
        if self._icon is not None:
            try:
                self._icon.stop()
            except Exception:  # noqa: BLE001
                pass
        self._icon = None


# ─────────────────────────────────── facade ─────────────────────────────────

class Transparency:
    """One object wiring banner + toasts + overlay + tray together.

    Every method is thread-safe and exception-guarded; headless environments
    fall back to console output. THERE IS NO WAY TO DISABLE THIS CLASS —
    agent.py unconditionally creates it and passes it to the managers.
    """

    def __init__(self) -> None:
        assert_enforced()
        self.notifier = Notifier()
        self.overlay = RecordingOverlay()
        self.tray: Optional[TrayIcon] = None

    def banner(self, hub_url: str, agent_id: str, friendly_name: str, version: str) -> None:
        print_banner(hub_url, agent_id, friendly_name, version)

    def remote_action(self, kind: str, detail: str) -> None:
        self.notifier.remote_action(kind, detail)

    def recording_start(self, label: Optional[str], notice_text: Optional[str] = None) -> None:
        """Show the overlay + toast + red tray dot (all mandatory)."""
        self.notifier.recording_started(label or "recording")
        self.overlay.start(label)
        if self.tray is not None:
            self.tray.set_recording(True)

    def recording_stop(self, label: Optional[str], state: str) -> None:
        self.notifier.recording_stopped(label or "recording", state)
        self.overlay.stop()
        if self.tray is not None:
            self.tray.set_recording(False)

    def start_tray(self, status_provider: Callable[[], str]) -> None:
        self.tray = TrayIcon(status_provider)
        self.tray.start()

    def shutdown(self) -> None:
        try:
            if self.tray is not None:
                self.tray.shutdown()
        finally:
            self.overlay.shutdown()
