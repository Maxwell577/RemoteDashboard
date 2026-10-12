"""Hub link: the socket.io client wiring the agent to the SentraRMM hub.

Protocol (v0.3, see src/lib/types.ts bottom section):
  agent:register { info: AgentInfo + captures }   on every (re)connect
  agent:heartbeat { agentId, metrics, location }  every heartbeatSec (real psutil)
  agent:request  { requestId, type, payload }     → handled on a worker pool
  agent:reply    { requestId, ok, data | error }
  stream:frame   StreamFrame (push)
  record:status / record:chunk / record:manifest (chunk+manifest with acks)

Design rules: the socket thread NEVER runs user handlers (worker pool), a
handler exception becomes an honest error reply, and reconnects re-register
and flush any spooled recording chunks.
"""
from __future__ import annotations

import logging
import os
import subprocess
import sys
import threading
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Callable, Dict, Optional, Tuple

log = logging.getLogger("sentra.hublink")

IS_WIN = sys.platform.startswith("win")


def _iso(ts: float) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(ts)) + "Z"


def _windows_gdi_screenshot() -> Dict[str, Any]:
    """Windows screen capture through PowerShell GDI (System.Drawing).

    Fallback for boxes where mss is unavailable: launches powershell.exe with
    CopyFromScreen over the virtual screen, gets PNG bytes back as base64 and
    re-encodes to JPEG (Pillow). Raises honestly when anything is missing.
    """
    import base64
    import io

    ps_script = (
        "Add-Type -AssemblyName System.Windows.Forms,System.Drawing;"
        "$b=[System.Windows.Forms.SystemInformation]::VirtualScreen;"
        "$bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height;"
        "$g=[System.Drawing.Graphics]::FromImage($bmp);"
        "$g.CopyFromScreen($b.Left,$b.Top,0,0,$bmp.Size);"
        "$ms=New-Object System.IO.MemoryStream;"
        "$bmp.Save($ms,[System.Drawing.Imaging.ImageFormat]::Png);"
        "[Convert]::ToBase64String($ms.ToArray())"
    )
    proc = subprocess.run(
        ["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy",
         "Bypass", "-Command", ps_script],
        capture_output=True, timeout=20,
    )
    if proc.returncode != 0:
        raise RuntimeError(
            "powershell GDI capture failed: "
            + (proc.stderr.decode("utf-8", "replace")[-300:] or f"exit {proc.returncode}")
        )
    png = base64.b64decode(proc.stdout.decode("ascii", "ignore").strip())
    from PIL import Image  # type: ignore - Pillow is a core dep

    img = Image.open(io.BytesIO(png)).convert("RGB")
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=80)
    jpg = buf.getvalue()
    return {
        "dataUri": "data:image/jpeg;base64," + base64.b64encode(jpg).decode("ascii"),
        "sizeBytes": len(jpg),
        "via": "windows-gdi-powershell",
        "width": int(img.width),
        "height": int(img.height),
    }


# ────────────────────────────────── metrics ─────────────────────────────────

class Metrics:
    """Real telemetry from psutil (cpu via cpu_times deltas, io_counters deltas)."""

    def __init__(self, agent_id: str) -> None:
        self.agent_id = agent_id
        self.boot_time = 0.0
        self._prev_cpu: Optional[Tuple[float, float]] = None  # (busy, total)
        self._prev_net: Optional[Tuple[int, int, float]] = None  # (rx, tx, ts)
        try:
            import psutil  # type: ignore

            self.boot_time = float(psutil.boot_time())
            self._prime(psutil)
        except Exception as exc:  # noqa: BLE001
            log.warning("psutil unavailable, telemetry will degrade: %s", exc)

    def _prime(self, psutil: Any) -> None:
        try:
            self._prev_cpu = self._cpu_times(psutil)
            self._prev_net = self._net_bytes(psutil)
        except Exception:  # noqa: BLE001
            pass

    @staticmethod
    def _cpu_times(psutil: Any) -> Tuple[float, float]:
        t = psutil.cpu_times()
        total = (t.user + t.nice + t.system + t.idle + getattr(t, "iowait", 0.0)
                 + getattr(t, "irq", 0.0) + getattr(t, "softirq", 0.0)
                 + getattr(t, "steal", 0.0))
        busy = total - t.idle - getattr(t, "iowait", 0.0)
        return busy, total

    @staticmethod
    def _net_bytes(psutil: Any) -> Tuple[int, int, float]:
        per = psutil.net_io_counters(pernic=True)
        rx = tx = 0
        for name, c in per.items():
            if name == "lo" or name.lower().startswith("loopback"):
                continue
            rx += int(c.bytes_recv)
            tx += int(c.bytes_sent)
        return rx, tx, time.monotonic()

    def snapshot(self) -> Dict[str, Any]:
        """DeviceMetrics shape (real values; honest zeros when psutil is gone)."""
        cpu = mem = disk = 0.0
        up = down = 0.0
        users = 1
        try:
            import psutil  # type: ignore

            busy, total = self._cpu_times(psutil)
            if self._prev_cpu is not None:
                d_busy = busy - self._prev_cpu[0]
                d_total = total - self._prev_cpu[1]
                if d_total > 0:
                    cpu = round(min(100.0, max(0.0, d_busy / d_total * 100.0)), 1)
            self._prev_cpu = (busy, total)

            mem = round(psutil.virtual_memory().percent, 1)

            probe = os.path.expanduser("~") if os.path.isdir(os.path.expanduser("~")) else os.getcwd()
            try:
                disk = round(psutil.disk_usage(probe).percent, 1)
            except Exception:  # noqa: BLE001 - odd mounts
                disk = 0.0

            users = max(1, len(psutil.users()))

            rx, tx, ts = self._net_bytes(psutil)
            if self._prev_net is not None:
                dt = max(0.001, ts - self._prev_net[2])
                down = round(max(0.0, (rx - self._prev_net[0]) / 1024.0 / dt), 1)
                up = round(max(0.0, (tx - self._prev_net[1]) / 1024.0 / dt), 1)
            self._prev_net = (rx, tx, ts)
        except Exception as exc:  # noqa: BLE001
            log.debug("metrics degraded: %s", exc)

        return {
            "deviceId": self.agent_id,
            "cpuPercent": cpu,
            "memoryPercent": mem,
            "diskPercent": disk,
            "uptimeSec": int(time.time() - self.boot_time) if self.boot_time else 0,
            "activeUsers": users,
            "netUpKBps": up,
            "netDownKBps": down,
            "capturedAt": _iso(time.time()),
        }


# ─────────────────────────────────── hub link ───────────────────────────────

class HubLink:
    """Owns the socket.io client + request handlers + heartbeat loop."""

    def __init__(self, cfg: Dict[str, Any], info: Dict[str, Any], captures: Dict[str, Any],
                 transparency: Any, stop_event: threading.Event) -> None:
        import socketio  # hard dep (requirements) — imported here for clean --print-info

        self.cfg = cfg
        self.info = info
        self.captures = captures
        self.transparency = transparency
        self.stop_event = stop_event
        self.agent_id = str(info["agentId"])
        self.connected = threading.Event()
        self._registered = threading.Event()

        self.metrics = Metrics(self.agent_id)
        self._executor = ThreadPoolExecutor(max_workers=4, thread_name_prefix="sentra-req")
        self._hb_thread: Optional[threading.Thread] = None

        self.sio = socketio.Client(
            reconnection=True,
            reconnection_attempts=0,  # infinite
            reconnection_delay=1.0,
            reconnection_delay_max=10.0,
            logger=False,
            engineio_logger=False,
        )
        self._wire_handlers()

        from .recorder import RecordingManager
        from .streams import StreamManager

        # NOTE: constructor arguments are POSITIONAL ON PURPOSE. The PyFortress
        # RFT pass renames ``__init__`` parameter names per-module and only
        # fixes keyword arguments for same-module call sites, so cross-module
        # keyword construction breaks in protected builds. Keep these calls
        # positional (or same-module) when extending the manager APIs.
        self.streams = StreamManager(
            self.agent_id,
            self._emit_stream_frame,
            self._emit_stream_ended,
        )
        self.recorder = RecordingManager(
            self.agent_id,
            cfg,
            str(cfg.get("_recordingsDirResolved") or "recordings"),
            transparency,
            lambda: self.connected.is_set(),
            self._emit_record_chunk,
            self._emit_record_status,
            self._emit_record_manifest,
        )
        self._handlers: Dict[str, Callable[[Dict[str, Any]], Any]] = self._build_handlers()

    # ------------------------------------------------------------ lifecycle

    def start(self) -> None:
        threading.Thread(target=self._connect_loop, name="sentra-connect", daemon=True).start()
        threading.Thread(target=self._reconnect_watchdog, name="sentra-watchdog", daemon=True).start()
        self._hb_thread = threading.Thread(target=self._heartbeat_loop, name="sentra-hb", daemon=True)
        self._hb_thread.start()

    def _try_connect(self) -> None:
        """One background connect attempt (raises nothing)."""
        url = str(self.cfg.get("hubUrl", "http://127.0.0.1:3003"))
        try:
            # polling first: some networks/hosts refuse the websocket upgrade;
            # engine.io will transparently upgrade when it can.
            self.sio.connect(url, socketio_path="/",
                             transports=["polling", "websocket"],
                             wait=False, wait_timeout=10)
        except Exception as exc:  # noqa: BLE001 - hub down / already connecting
            log.debug("connect attempt: %s", exc)

    def _connect_loop(self) -> None:
        first = True
        while not self.stop_event.is_set():
            self._try_connect()
            if first:
                log.info("hub link starting (%s)", self.cfg.get("hubUrl"))
                first = False
            return  # connect() is async; the watchdog takes over from here

    def _reconnect_watchdog(self) -> None:
        """Reconnection safety net (belt-and-braces around socketio's own).

        Observed failure mode in the wild: after a server-side disconnect the
        python-socketio client can wedge (``packet queue is empty, aborting``)
        and simply stop retrying. The watchdog notices ``connected`` staying
        clear for >10s and forces a fresh disconnect+connect cycle — losing the
        hub must never be a silent, permanent state.
        """
        while not self.stop_event.is_set():
            if self.connected.is_set():
                if self.stop_event.wait(5.0):
                    return
                continue
            if self.stop_event.wait(10.0):
                return
            if self.connected.is_set() or self.stop_event.is_set():
                continue
            log.info("watchdog: no hub connection — forcing a reconnect cycle")
            try:
                self.sio.disconnect()
            except Exception:  # noqa: BLE001 - already gone
                pass
            self._try_connect()

    def stop(self) -> None:
        try:
            self.recorder.stop_all()
        except Exception:  # noqa: BLE001
            pass
        try:
            self.streams.stop_all()
        except Exception:  # noqa: BLE001
            pass
        try:
            self.sio.disconnect()
        except Exception:  # noqa: BLE001
            pass
        self._executor.shutdown(wait=False)

    # -------------------------------------------------------- socket events

    def _wire_handlers(self) -> None:
        sio = self.sio

        @sio.on("connect")
        def _on_connect() -> None:  # pragma: no cover - exercised via E2E
            self.connected.set()
            log.info("connected to hub (socket %s)", sio.get_sid() or "?")
            info = {**self.info, "captures": self.captures}
            sio.emit("agent:register", {"info": info}, callback=self._register_ack)
            # reconnect: flush any recording chunks spooled while offline
            try:
                self.recorder.on_reconnect()
            except Exception:  # noqa: BLE001
                log.exception("spool flush on reconnect failed")

        @sio.on("disconnect")
        def _on_disconnect(reason: Any = None) -> None:
            self.connected.clear()
            self._registered.clear()
            log.info("disconnected from hub (%s) — will reconnect", reason)

        @sio.on("connect_error")
        def _on_connect_error(data: Any = None) -> None:
            log.info("hub connection error: %s", data)

        @sio.on("agent:request")
        def _on_request(msg: Optional[Dict[str, Any]]) -> None:
            if not isinstance(msg, dict):
                return
            request_id = msg.get("requestId")
            req_type = msg.get("type")
            payload = msg.get("payload") or {}
            if not isinstance(request_id, str) or not isinstance(req_type, str):
                return
            self._executor.submit(self._handle_request, request_id, req_type, payload)

    def _register_ack(self, *args: Any) -> None:
        ack = args[0] if args else None
        if isinstance(ack, dict) and ack.get("ok"):
            self._registered.set()
            log.info("registered — device should now appear in the console")
        else:
            log.error("registration rejected: %s", (ack or {}).get("error", "unknown error"))

    # ------------------------------------------------------------- requests

    def _handle_request(self, request_id: str, req_type: str, payload: Dict[str, Any]) -> None:
        try:
            handler = self._handlers.get(req_type)
            if handler is None:
                raise ValueError(f"Unknown request type '{req_type}'")
            data = handler(payload)
            self.sio.emit("agent:reply", {"requestId": request_id, "ok": True, "data": data})
        except Exception as exc:  # noqa: BLE001 - honest error reply, never crash
            log.warning("%s failed: %s", req_type, exc)
            try:
                self.sio.emit("agent:reply", {"requestId": request_id, "ok": False,
                                              "error": str(exc)})
            except Exception:  # noqa: BLE001
                pass

    def _build_handlers(self) -> Dict[str, Callable[[Dict[str, Any]], Any]]:
        from .fsops import FileScope
        from .processes import list_processes, process_action
        from .terminal import run_command

        scope = FileScope(self.cfg.get("_fsRootResolved") or os.path.expanduser("~"))

        def fs_handler(kind: str,
                       fn: Callable[[Dict[str, Any]], Any],
                       detail: Callable[[Dict[str, Any]], str]) -> Callable[[Dict[str, Any]], Any]:
            """Wrap a fs op so the device user sees a toast before it runs."""
            def run(payload: Dict[str, Any]) -> Any:
                try:  # MANDATORY transparency: announce file operations
                    self.transparency.remote_action("fs", detail(payload))
                except Exception:  # noqa: BLE001 - transparency must never break the op
                    pass
                return fn(payload)
            return run

        def fs_detail(_kind: str) -> Callable[[Dict[str, Any]], str]:
            def render(p: Dict[str, Any]) -> str:
                parts = [str(p.get("path") or ".")]
                for key in ("name", "newName"):
                    if p.get(key):
                        parts.append(f"{key}={p[key]}")
                return f"{kind}: {', '.join(parts)}"[:160]
            return render

        def exec_handler(payload: Dict[str, Any]) -> Dict[str, Any]:
            command = str(payload.get("command") or "")
            try:  # MANDATORY transparency: announce remote commands
                self.transparency.remote_action("exec", command[:120])
            except Exception:  # noqa: BLE001
                pass
            log.info("exec: %s", command)
            return run_command(command, payload.get("shell"))

        def screenshot_handler(_payload: Dict[str, Any]) -> Dict[str, Any]:
            try:  # MANDATORY transparency: announce the capture
                self.transparency.remote_action("screenshot", "screen capture taken by an operator")
            except Exception:  # noqa: BLE001
                pass
            try:
                import base64

                import mss  # type: ignore

                from .streams import jpeg_bytes_bgra
                with mss.mss() as sct:
                    mon = sct.monitors[0]  # full virtual screen
                    shot = sct.grab(mon)
                jpg = jpeg_bytes_bgra(shot.bgra, shot.width, shot.height, quality=80)
                return {"dataUri": "data:image/jpeg;base64,"
                        + base64.b64encode(jpg).decode("ascii"),
                        "sizeBytes": len(jpg)}
            except Exception as exc:  # noqa: BLE001
                if IS_WIN:  # GDI fallback via PowerShell (audit: Windows GDI path)
                    try:
                        return _windows_gdi_screenshot()
                    except Exception as exc2:  # noqa: BLE001
                        raise RuntimeError(
                            f"media:screenshot failed (mss: {exc}; windows GDI fallback: {exc2})"
                        ) from exc2
                raise RuntimeError(
                    f"media:screenshot needs mss + a display on this machine: {exc}"
                ) from exc

        return {
            "exec": exec_handler,
            "ps:list": lambda p: list_processes(self.metrics.snapshot),
            "ps:action": lambda p: process_action(int(p.get("pid") or 0), str(p.get("action") or "")),
            "fs:list": fs_handler("list", lambda p: scope.list(p.get("path")),
                                  fs_detail("list")),
            "fs:download": fs_handler("download", lambda p: scope.download(p.get("path")),
                                      fs_detail("download")),
            "fs:upload": fs_handler("upload", lambda p: scope.upload(p.get("path"), p.get("name"), p.get("contentBase64")),
                                    fs_detail("upload")),
            "fs:delete": fs_handler("delete", lambda p: scope.delete(p.get("path")),
                                    fs_detail("delete")),
            "fs:rename": fs_handler("rename", lambda p: scope.rename(p.get("path"), p.get("newName")),
                                    fs_detail("rename")),
            "fs:mkdir": fs_handler("mkdir", lambda p: scope.mkdir(p.get("path")),
                                   fs_detail("mkdir")),
            "media:screenshot": screenshot_handler,
            "stream:start": self._stream_start,
            "stream:stop": self._stream_stop,
            # legacy v0.2 single-screen channel → mapped onto the stream manager
            "screen:live:start": self._legacy_screen_start,
            "screen:live:stop": self._legacy_screen_stop,
            "record:schedule": self.recorder.schedule,
            "record:cancel": self.recorder.cancel,
            "record:status": lambda p: self.recorder.status(),
            # honest limitations (never fake data)
            "location:fix": self._not_impl("location:fix",
                                           "needs an OS geolocation source — not implemented in the Python agent"),
            "net:start": self._not_impl("net:start",
                                        "needs a packet-capture backend (pktcap/pcap) — not implemented in the Python agent"),
            "net:stop": self._not_impl("net:stop",
                                       "needs a packet-capture backend (pktcap/pcap) — not implemented in the Python agent"),
        }

    @staticmethod
    def _not_impl(name: str, why: str) -> Callable[[Dict[str, Any]], Any]:
        def fail(_payload: Dict[str, Any]) -> Any:
            raise NotImplementedError(f"{name}: {why}")
        return fail

    # ───────────────────────────── streams ────────────────────────────────

    def _stream_start(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        try:
            self.transparency.remote_action(
                "stream", f"{payload.get('kind', '?')} stream started"
                + (f" ({payload.get('sourceId')})" if payload.get("sourceId") else ""))
        except Exception:  # noqa: BLE001
            pass
        return self.streams.start(payload)

    def _stream_stop(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        return self.streams.stop(str(payload.get("streamId") or ""))

    def _legacy_screen_start(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        fps = payload.get("fps") or 1
        try:  # MANDATORY transparency: legacy live view is a remote action too
            self.transparency.remote_action("stream", "live screen view started (legacy)")
        except Exception:  # noqa: BLE001
            pass
        return self.streams.start({
            "streamId": "legacy-screen-" + uuid.uuid4().hex[:8],
            "kind": "screen", "sourceId": None, "fps": fps, "quality": "source",
        })

    def _legacy_screen_stop(self, _payload: Dict[str, Any]) -> Dict[str, Any]:
        # stop every legacy screen stream still running
        total = 0
        for stream_id in self.streams.stream_ids():
            if stream_id.startswith("legacy-screen-"):
                total += self.streams.stop(stream_id)["frames"]
        return {"frames": total}

    def _emit_stream_frame(self, frame: Dict[str, Any]) -> None:
        if not self.connected.is_set():
            return
        try:
            self.sio.emit("stream:frame", frame)
        except Exception:  # noqa: BLE001 - frames are lossy, never raise
            pass

    def _emit_stream_ended(self, msg: Dict[str, Any]) -> None:
        if not self.connected.is_set():
            return
        try:
            self.sio.emit("stream:ended", msg)
        except Exception:  # noqa: BLE001
            pass

    # ───────────────────────────── recordings ─────────────────────────────

    def _emit_record_status(self, msg: Dict[str, Any]) -> None:
        if not self.connected.is_set():
            log.info("record:status (offline) %s", msg)
            return
        try:
            self.sio.emit("record:status", msg)
        except Exception as exc:  # noqa: BLE001
            log.warning("record:status emit failed: %s", exc)

    def _emit_with_ack(self, event: str, data: Dict[str, Any],
                       timeout: float = 8.0) -> Tuple[bool, str]:
        """Emit and wait for the server ack → (ok, error)."""
        holder: Dict[str, Any] = {}
        done = threading.Event()

        def cb(*args: Any) -> None:
            holder["ack"] = args[0] if args else None
            done.set()

        try:
            self.sio.emit(event, data, callback=cb)
        except Exception as exc:  # noqa: BLE001
            return False, f"emit failed: {exc}"
        if not done.wait(timeout):
            return False, "ack timeout"
        ack = holder.get("ack")
        if isinstance(ack, dict):
            ok = bool(ack.get("ok", True))
            return ok, ("" if ok else str(ack.get("error") or "nack"))
        if isinstance(ack, bool):
            return ack, ("" if ack else "nack")
        return True, ""

    def _emit_record_chunk(self, _recording_id: str, payload: Dict[str, Any]) -> Tuple[bool, str]:
        if not self.connected.is_set():
            return False, "offline"
        return self._emit_with_ack("record:chunk", payload)

    def _emit_record_manifest(self, payload: Dict[str, Any]) -> Tuple[bool, str]:
        if not self.connected.is_set():
            return False, "offline"
        return self._emit_with_ack("record:manifest", payload)

    # ───────────────────────────── heartbeat ──────────────────────────────

    def _heartbeat_loop(self) -> None:
        interval = int(self.cfg.get("heartbeatSec", 15))
        # small startup delay so the first delta is meaningful
        if self.stop_event.wait(min(2.0, interval)):
            return
        while not self.stop_event.is_set():
            if self.connected.is_set():
                try:
                    snap = self.metrics.snapshot()
                    self.sio.emit("agent:heartbeat", {
                        "agentId": self.agent_id, "metrics": snap, "location": None,
                    })
                    log.info("heartbeat cpu=%.1f%% mem=%.1f%% disk=%.1f%% net=↑%.1f ↓%.1f KBps",
                             snap["cpuPercent"], snap["memoryPercent"], snap["diskPercent"],
                             snap["netUpKBps"], snap["netDownKBps"])
                except Exception as exc:  # noqa: BLE001 - heartbeat must never kill the loop
                    log.warning("heartbeat failed: %s", exc)
            self.stop_event.wait(interval)
