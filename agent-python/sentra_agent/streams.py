"""Live multi-source streams (v0.3 ``stream:start/stop`` + ``stream:frame``).

Any number of streams can run concurrently, each on its own thread:
  * screen (per monitor, mss)   — JPEG ~70, fps capped at 5
  * camera (OpenCV)             — JPEG ~70, fps capped at 15, optional 480p/720p/1080p
  * mic    (sounddevice)        — RMS level 0..1 emitted at ~8 Hz

Frames are pushed through the HubLink as ``stream:frame`` events
(StreamFrame: dataUri image/jpeg for screen/camera, ``level`` for mic).
``stop()`` joins every thread. A camera that disappears ends its stream with
an honest ``stream:ended`` (reason) instead of erroring the hub.
"""
from __future__ import annotations

import base64
import logging
import threading
import time
from typing import Any, Callable, Dict, List, Optional

log = logging.getLogger("sentra.streams")

SCREEN_FPS_CAP = 5.0
CAMERA_FPS_CAP = 15.0
MIC_RATE_HZ = 8
QUALITY_HEIGHTS = {"480p": 480, "720p": 720, "1080p": 1080}


def jpeg_bytes_bgra(raw: Any, width: int, height: int, quality: int = 70) -> bytes:
    """Encode an mss BGRA frame to RAW JPEG bytes (cv2 preferred, PIL fallback).

    Callers base64-encode the result themselves (the old ``_jpeg_b64_bga``
    name lied about returning base64 — renamed for honesty).
    """
    try:
        import cv2  # type: ignore
        import numpy as np  # type: ignore

        arr = np.frombuffer(raw, dtype=np.uint8).reshape((height, width, 4))
        img = cv2.cvtColor(arr, cv2.COLOR_BGRA2BGR)
        ok, buf = cv2.imencode(".jpg", img, [int(cv2.IMWRITE_JPEG_QUALITY), quality])
        if not ok:
            raise RuntimeError("cv2 JPEG encode failed")
        return buf.tobytes()
    except ImportError:
        pass
    # PIL fallback (mss gives BGRA byte order — tell PIL via the raw decoder)
    from PIL import Image  # type: ignore
    import io

    img = Image.frombytes("RGBA", (width, height), bytes(raw), "raw", "BGRA")
    rgb = img.convert("RGB")
    buf = io.BytesIO()
    rgb.save(buf, format="JPEG", quality=quality)
    return buf.getvalue()


def _jpeg_b64_bgr(img: Any, quality: int = 70) -> bytes:
    import cv2  # type: ignore

    ok, buf = cv2.imencode(".jpg", img, [int(cv2.IMWRITE_JPEG_QUALITY), quality])
    if not ok:
        raise RuntimeError("cv2 JPEG encode failed")
    return buf.tobytes()


class _StreamThread(threading.Thread):
    """One live stream. Sets ``ready`` with ``meta`` or ``error`` for the ack."""

    def __init__(self, agent_id: str, desc: Dict[str, Any],
                 emit_frame: Callable[[Dict[str, Any]], None],
                 emit_ended: Callable[[Dict[str, Any]], None]) -> None:
        super().__init__(name=f"sentra-stream-{desc.get('streamId', '?')}", daemon=True)
        self.agent_id = agent_id
        self.desc = desc
        self.stream_id = str(desc.get("streamId", ""))
        self.kind = str(desc.get("kind", ""))
        self.source_id = desc.get("sourceId") or None
        self.emit_frame = emit_frame
        self.emit_ended = emit_ended
        self.ready = threading.Event()
        self.error: Optional[str] = None
        self.meta: Dict[str, Any] = {}
        self.stop_flag = threading.Event()
        self.frames = 0
        self.seq = 0

    # ------------------------------------------------------------------ util

    def _frame(self, **kw: Any) -> Dict[str, Any]:
        self.seq += 1
        self.frames += 1
        out: Dict[str, Any] = {
            "agentId": self.agent_id,
            "streamId": self.stream_id,
            "kind": self.kind,
            "ts": int(time.time() * 1000),
            "seq": self.seq,
        }
        out.update(kw)
        return out

    def _run_screen(self) -> None:
        import mss  # type: ignore

        fps = min(SCREEN_FPS_CAP, max(0.5, float(self.desc.get("fps") or 1)))
        idx: Optional[int] = None
        if self.source_id and str(self.source_id).startswith("monitor:"):
            try:
                idx = int(str(self.source_id).split(":", 1)[1])
            except ValueError:
                idx = None
        interval = 1.0 / fps
        with mss.mss() as sct:
            monitors = list(sct.monitors)
            if idx is None:
                mon = monitors[1] if len(monitors) > 1 else monitors[0]
            else:
                mon = monitors[idx + 1] if idx + 1 < len(monitors) else monitors[0]
            self.meta = {"width": int(mon.get("width", 0)), "height": int(mon.get("height", 0)),
                         "fps": fps}
            self.ready.set()
            next_t = time.monotonic()
            while not self.stop_flag.is_set():
                shot = sct.grab(mon)
                jpg = jpeg_bytes_bgra(shot.bgra, shot.width, shot.height, quality=70)
                self.emit_frame(self._frame(
                    dataUri="data:image/jpeg;base64," + base64.b64encode(jpg).decode("ascii"),
                    width=int(shot.width), height=int(shot.height),
                ))
                next_t += interval
                sleep = next_t - time.monotonic()
                if sleep > 0:
                    if self.stop_flag.wait(sleep):
                        break
                else:
                    next_t = time.monotonic()

    def _run_camera(self) -> None:
        import cv2  # type: ignore

        fps = min(CAMERA_FPS_CAP, max(0.5, float(self.desc.get("fps") or 5)))
        try:
            cam_idx = int(str(self.source_id).split(":", 1)[1]) if self.source_id else 0
        except ValueError:
            cam_idx = 0
        backend = getattr(cv2, "CAP_DSHOW", 0) if sys_platform_win() else getattr(cv2, "CAP_ANY", 0)
        cap = cv2.VideoCapture(cam_idx, backend)
        if not cap.isOpened():
            cap.release()
            self.error = f"camera:{cam_idx} could not be opened"
            self.ready.set()
            return
        target_h = QUALITY_HEIGHTS.get(str(self.desc.get("quality") or "source"))
        if target_h:
            try:
                src_w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)) or 640
                src_h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT)) or 480
                scale = target_h / float(src_h)
                cap.set(cv2.CAP_PROP_FRAME_WIDTH, max(320, int(src_w * scale)))
                cap.set(cv2.CAP_PROP_FRAME_HEIGHT, target_h)
            except Exception:  # noqa: BLE001 - backend may refuse scaling
                pass
        w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        self.meta = {"width": w, "height": h, "fps": fps}
        self.ready.set()
        interval = 1.0 / fps
        consecutive_failures = 0
        next_t = time.monotonic()
        try:
            while not self.stop_flag.is_set():
                ok, img = cap.read()
                if not ok:
                    consecutive_failures += 1
                    if consecutive_failures >= 10:
                        raise RuntimeError(f"camera:{cam_idx} stopped delivering frames")
                    time.sleep(0.1)
                    continue
                consecutive_failures = 0
                jpg = _jpeg_b64_bgr(img, quality=70)
                self.emit_frame(self._frame(
                    dataUri="data:image/jpeg;base64," + base64.b64encode(jpg).decode("ascii"),
                    width=int(img.shape[1]), height=int(img.shape[0]),
                ))
                next_t += interval
                sleep = next_t - time.monotonic()
                if sleep > 0:
                    if self.stop_flag.wait(sleep):
                        break
                else:
                    next_t = time.monotonic()
        finally:
            cap.release()

    def _run_mic(self) -> None:
        import numpy as np  # type: ignore
        import sounddevice as sd  # type: ignore

        dev_idx: Optional[int] = None
        if self.source_id and str(self.source_id).startswith("mic:"):
            try:
                dev_idx = int(str(self.source_id).split(":", 1)[1])
            except ValueError:
                dev_idx = None
        latest = {"rms": 0.0}
        got_audio = threading.Event()

        def callback(indata: Any, frames: int, time_info: Any, status: Any) -> None:
            try:
                mono = indata[:, 0].astype("float32")
                rms = float(np.sqrt(np.mean(np.square(mono))))
                latest["rms"] = min(1.0, max(0.0, rms * 4.0))
                got_audio.set()
            except Exception:  # noqa: BLE001 - audio callback must never raise
                pass

        try:
            stream = sd.InputStream(
                samplerate=16000, channels=1, dtype="float32",
                device=dev_idx, blocksize=1024, callback=callback,
            )
        except Exception as exc:  # noqa: BLE001 - no PortAudio / device busy
            self.error = f"microphone unavailable: {exc}"
            self.ready.set()
            return
        self.meta = {"fps": MIC_RATE_HZ}
        self.ready.set()
        interval = 1.0 / MIC_RATE_HZ
        with stream:
            next_t = time.monotonic()
            while not self.stop_flag.is_set():
                self.emit_frame(self._frame(level=round(latest["rms"], 4)))
                next_t += interval
                sleep = next_t - time.monotonic()
                if sleep > 0:
                    if self.stop_flag.wait(sleep):
                        break
                else:
                    next_t = time.monotonic()
        if not got_audio.is_set():
            log.info("mic stream %s closed without receiving audio", self.stream_id)

    # ------------------------------------------------------------------ run

    def run(self) -> None:
        reason = "stopped"
        try:
            if self.kind == "screen":
                self._run_screen()
            elif self.kind == "camera":
                self._run_camera()
            elif self.kind == "mic":
                self._run_mic()
            else:
                self.error = f"unknown stream kind '{self.kind}'"
                self.ready.set()
                return
        except Exception as exc:  # noqa: BLE001 - report honestly, never crash the hub
            reason = f"error: {exc}"
            log.warning("stream %s failed: %s", self.stream_id, exc)
        finally:
            self.ready.set()
            self.emit_ended({
                "agentId": self.agent_id, "streamId": self.stream_id,
                "kind": self.kind, "frames": self.frames, "reason": reason,
            })


def sys_platform_win() -> bool:
    import sys

    return sys.platform.startswith("win")


class StreamManager:
    """Owns all live streams; started/stopped from hub request handlers."""

    def __init__(self, agent_id: str,
                 emit_frame: Callable[[Dict[str, Any]], None],
                 emit_ended: Callable[[Dict[str, Any]], None]) -> None:
        self.agent_id = agent_id
        self.emit_frame = emit_frame
        self.emit_ended = emit_ended
        self._streams: Dict[str, _StreamThread] = {}
        self._lock = threading.Lock()

    def start(self, desc: Dict[str, Any]) -> Dict[str, Any]:
        """Start a stream and return the ack payload (raises on failure)."""
        stream_id = str(desc.get("streamId") or "")
        if not stream_id:
            raise ValueError("streamId is required")
        kind = str(desc.get("kind") or "")
        if kind not in ("screen", "camera", "mic"):
            raise ValueError(f"unsupported stream kind '{kind}'")
        with self._lock:
            existing = self._streams.get(stream_id)
            if existing is not None and existing.is_alive():
                return {"started": True, "meta": existing.meta}
            thread = _StreamThread(self.agent_id, desc, self.emit_frame, self.emit_ended)
            self._streams[stream_id] = thread
        thread.start()
        if not thread.ready.wait(timeout=6.0):
            self._drop(stream_id)
            raise TimeoutError(f"stream {stream_id} did not initialize (capture backend busy?)")
        if thread.error:
            self._drop(stream_id)
            raise RuntimeError(thread.error)
        return {"started": True, "meta": thread.meta}

    def stop(self, stream_id: str) -> Dict[str, Any]:
        """Stop one stream; returns {frames: n}."""
        with self._lock:
            thread = self._streams.pop(str(stream_id), None)
        if thread is None:
            return {"frames": 0}
        thread.stop_flag.set()
        thread.join(timeout=4.0)
        return {"frames": thread.frames}

    def stop_all(self) -> None:
        with self._lock:
            threads = list(self._streams.values())
            self._streams.clear()
        for thread in threads:
            thread.stop_flag.set()
        for thread in threads:
            thread.join(timeout=3.0)

    def _drop(self, stream_id: str) -> None:
        with self._lock:
            self._streams.pop(stream_id, None)

    def stream_ids(self) -> List[str]:
        """Ids of every registered stream (public accessor — RFT-safe)."""
        with self._lock:
            return list(self._streams.keys())

    def active_count(self) -> int:
        with self._lock:
            return sum(1 for t in self._streams.values() if t.is_alive())
