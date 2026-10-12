"""Scheduled encrypted recordings (v0.3 ``record:schedule`` family).

Flow (state machine ``armed → recording → completed|failed|canceled``):

1.  ``schedule`` validates durationSec (≤ maxRecordingMin*60) and free disk
    space (≥ minFreeMB), NOTIFIES THE DEVICE USER (mandatory transparency,
    using ``noticeText`` when provided) and acks ``{accepted: true, state}``.
2.  A daemon job thread captures the selected sources — screen monitors at
    2 fps (mss), cameras at 5 fps (OpenCV), mic levels at 4 Hz — and appends
    plaintext JSON records to memory buffers.
3.  ENCRYPT-THEN-WRITE: records are grouped into ≤64KB plaintext groups,
    each group is AES-256-GCM encrypted and framed as
    ``[u32BE len][12B nonce][ct][16B tag]`` (SENTRA-REC-1). Frames are BOTH
    appended to the local ``<recordingId>.enc`` file (the offline-safe copy)
    AND packed into ``record:chunk`` events (≤256KB payload, ordered seq,
    ack'd; on failure/nack they go to a local spool flushed on reconnect).
4.  On completion the file is sealed, sha256 computed, and ``record:manifest``
    emitted. ``record:cancel`` stops early (state ``canceled``).

The job runs in a daemon thread: losing the hub NEVER stops a recording.
The passphrase is used for key derivation only and is never logged.
"""
from __future__ import annotations

import base64
import hashlib
import io
import json
import logging
import os
import shutil
import threading
import time
from typing import Any, Callable, Dict, List, Optional, Tuple

log = logging.getLogger("sentra.recorder")

MAGIC = "SENTRA-REC-1"
CIPHER = "AES-256-GCM"
KDF = "PBKDF2-HMAC-SHA256"
KDF_ITERATIONS = 200000

RECORD_FPS_SCREEN = 2.0
RECORD_FPS_CAMERA = 5.0
MIC_RECORD_HZ = 4
GROUP_BYTES = 64 * 1024          # plaintext group size before encrypting
CHUNK_TARGET = 240 * 1024        # pack frames into chunks up to this (b64)
CHUNK_MAX = 256 * 1024           # hard contract cap per record:chunk payload
MAX_JPEG_BYTES = 160 * 1024      # keeps base64(frame) safely inside a chunk
ACK_TIMEOUT_S = 8.0
MAX_CONCURRENT = 2


def _iso_ms(ms: Optional[int]) -> Optional[str]:
    """Epoch-ms → ISO-8601 Z string (the hub's internal API requires ISO)."""
    if not ms:
        return None
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(ms / 1000.0)) + ".%03dZ" % (ms % 1000)


def _aad_for(recording_id: str) -> bytes:
    return hashlib.sha256(recording_id.encode("utf-8")).digest()[:16]


def _derive_key(passphrase: str, salt: bytes) -> bytes:
    return hashlib.pbkdf2_hmac(
        "sha256", passphrase.encode("utf-8"), salt, KDF_ITERATIONS, dklen=32,
    )


def _fit_jpeg_b64_bgra(raw: Any, width: int, height: int) -> str:
    """JPEG-encode an mss BGRA frame, shrinking quality/size to stay ≤ cap.

    Prefers OpenCV; falls back to PIL (same BGRA layout handling as
    :func:`sentra_agent.streams.jpeg_bytes_bgra`) so a Windows box without
    opencv-python can still record the screen honestly.
    """
    try:
        import cv2  # type: ignore
        import numpy as np  # type: ignore

        arr = np.frombuffer(raw, dtype=np.uint8).reshape((height, width, 4))
        img = cv2.cvtColor(arr, cv2.COLOR_BGRA2BGR)
        return _fit_jpeg_img(img)
    except ImportError:
        pass
    import io as _io

    from PIL import Image  # type: ignore

    from .streams import jpeg_bytes_bgra

    jpg = jpeg_bytes_bgra(raw, width, height, quality=70)
    if len(jpg) <= MAX_JPEG_BYTES:
        return base64.b64encode(jpg).decode("ascii")
    img = Image.open(_io.BytesIO(jpg))
    scale = 0.75
    while scale >= 0.3:
        small = img.resize((max(320, int(img.width * scale)), max(240, int(img.height * scale))))
        buf = _io.BytesIO()
        small.convert("RGB").save(buf, format="JPEG", quality=45)
        data = buf.getvalue()
        if len(data) <= MAX_JPEG_BYTES:
            return base64.b64encode(data).decode("ascii")
        scale -= 0.15
    return base64.b64encode(data).decode("ascii")


def _fit_jpeg_img(img: Any) -> str:
    """Encode a BGR image, lowering quality then scaling until ≤ MAX_JPEG_BYTES."""
    import cv2  # type: ignore

    for quality in (70, 55, 40):
        ok, buf = cv2.imencode(".jpg", img, [int(cv2.IMWRITE_JPEG_QUALITY), quality])
        if ok and len(buf) <= MAX_JPEG_BYTES:
            return base64.b64encode(buf.tobytes()).decode("ascii")
    h, w = img.shape[:2]
    scale = 0.75
    while scale >= 0.3:
        small = cv2.resize(img, (max(320, int(w * scale)), max(240, int(h * scale))))
        ok, buf = cv2.imencode(".jpg", small, [int(cv2.IMWRITE_JPEG_QUALITY), 45])
        if ok and len(buf) <= MAX_JPEG_BYTES:
            return base64.b64encode(buf.tobytes()).decode("ascii")
        scale -= 0.15
    # last resort — accept whatever we got at the smallest size
    ok, buf = cv2.imencode(".jpg", small, [int(cv2.IMWRITE_JPEG_QUALITY), 35])
    return base64.b64encode((buf.tobytes() if ok else b"")).decode("ascii")


class _RecordSink:
    """Thread-safe record collector feeding the encryptor."""

    def __init__(self) -> None:
        self._pending: List[Dict[str, Any]] = []
        self._lock = threading.Lock()

    def add(self, record: Dict[str, Any]) -> None:
        with self._lock:
            self._pending.append(record)

    def drain(self) -> List[Dict[str, Any]]:
        with self._lock:
            out = self._pending
            self._pending = []
            return out


class _ChunkUploader:
    """Sends record:chunk events with acks; spools failures for later flush."""

    def __init__(self, recordings_dir: str,
                 is_connected: Callable[[], bool],
                 emit_chunk: Callable[[str, Dict[str, Any]], Tuple[bool, str]],
                 emit_status: Callable[[Dict[str, Any]], None]) -> None:
        self.spool_dir = os.path.join(recordings_dir, "spool")
        try:
            os.makedirs(self.spool_dir, exist_ok=True)
        except OSError:
            pass
        self.is_connected = is_connected
        self.emit_chunk = emit_chunk          # → (ok, error)
        self.emit_status = emit_status
        self._queue: "list[Tuple[str, int, bytes]]" = []
        self._cv = threading.Condition()
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._loop, name="sentra-chunk-up", daemon=True)
        self._thread.start()

    # ------------------------------------------------------------------ api

    def submit(self, recording_id: str, seq: int, payload: bytes) -> None:
        with self._cv:
            self._queue.append((recording_id, seq, payload))
            self._cv.notify()

    def flush_spool(self) -> int:
        """Push all spooled chunks (ascending seq per recording). Returns sent count."""
        sent = 0
        try:
            recs = sorted(os.listdir(self.spool_dir))
        except OSError:
            return 0
        for rec_dir in recs:
            rec_path = os.path.join(self.spool_dir, rec_dir)
            if not os.path.isdir(rec_path):
                continue
            try:
                chunks = sorted(os.listdir(rec_path))
            except OSError:
                continue
            for name in chunks:
                if self._stop.is_set():
                    return sent
                path = os.path.join(rec_path, name)
                try:
                    with open(path, "rb") as fh:
                        payload = fh.read()
                    seq = int(name.split(".")[0])
                except (OSError, ValueError):
                    continue
                ok, _err = self.emit_chunk(rec_dir, {"recordingId": rec_dir, "seq": seq,
                                                     "dataB64": base64.b64encode(payload).decode("ascii")})
                if ok:
                    try:
                        os.remove(path)
                        sent += 1
                    except OSError:
                        pass
                else:
                    return sent  # still offline — stop early, stay spooled
        return sent

    def stop(self) -> None:
        self._stop.set()
        with self._cv:
            self._cv.notify()
        self._thread.join(timeout=3.0)

    # ----------------------------------------------------------------- loop

    def _spool(self, recording_id: str, seq: int, payload: bytes) -> None:
        rec_path = os.path.join(self.spool_dir, recording_id)
        try:
            os.makedirs(rec_path, exist_ok=True)
            with open(os.path.join(rec_path, f"{seq:08d}.chunk"), "wb") as fh:
                fh.write(payload)
        except OSError as exc:
            log.error("chunk spool write failed (%s seq=%d): %s", recording_id, seq, exc)

    def _loop(self) -> None:
        while not self._stop.is_set():
            with self._cv:
                if not self._queue:
                    self._cv.wait(timeout=0.5)
                item = self._queue.pop(0) if self._queue else None
            if item is None:
                continue
            recording_id, seq, payload = item
            if not self.is_connected():
                self._spool(recording_id, seq, payload)
                continue
            ok, err = self.emit_chunk(recording_id, {
                "recordingId": recording_id, "seq": seq,
                "dataB64": base64.b64encode(payload).decode("ascii"),
            })
            if ok:
                continue
            log.warning("record:chunk %s seq=%d rejected (%s) — spooled for retry", recording_id, seq, err)
            self._spool(recording_id, seq, payload)


class RecordingJob(threading.Thread):
    """One recording: capture threads → sink → encrypt → file + chunks."""

    def __init__(self, spec: Dict[str, Any], agent_id: str, recordings_dir: str,
                 uploader: _ChunkUploader, emit_status: Callable[[Dict[str, Any]], None],
                 emit_manifest: Callable[[Dict[str, Any]], Tuple[bool, str]],
                 transparency: Any, stop_event: threading.Event) -> None:
        super().__init__(name=f"sentra-rec-{spec.get('recordingId', '?')[:8]}", daemon=True)
        self.spec = spec
        self.recording_id = str(spec["recordingId"])
        self.duration_sec = int(spec.get("durationSec") or 0)
        self.agent_id = agent_id
        self.recordings_dir = recordings_dir
        self.uploader = uploader
        self.emit_status = emit_status
        self.emit_manifest = emit_manifest
        self.transparency = transparency
        self.global_stop = stop_event

        self.state = "armed"
        self.error: Optional[str] = None
        self.frames = 0
        self.size_bytes = 0
        self.started_at_ms: Optional[int] = None
        self.ended_at_ms: Optional[int] = None
        self._cancel = threading.Event()
        self.sink = _RecordSink()
        self.seq = 0

        self.salt = os.urandom(16)
        self.file_path = os.path.join(recordings_dir, f"{self.recording_id}.enc")
        self.capture_threads: List[threading.Thread] = []

    # ---------------------------------------------------------------- status

    def status_msg(self) -> Dict[str, Any]:
        msg: Dict[str, Any] = {
            "recordingId": self.recording_id,
            "state": self.state,
            "frames": self.frames,
        }
        if self.state == "recording" and self.started_at_ms:
            msg["elapsedSec"] = int((time.time() * 1000 - self.started_at_ms) / 1000)
        if self.size_bytes:
            msg["sizeBytes"] = self.size_bytes
        if self.started_at_ms:
            msg["startedAt"] = _iso_ms(self.started_at_ms)  # ISO — hub contract
        if self.ended_at_ms:
            msg["endedAt"] = _iso_ms(self.ended_at_ms)
        if self.error:
            msg["error"] = self.error
        return msg

    def cancel(self) -> None:
        self._cancel.set()

    # ------------------------------------------------------------- capture

    def _selected(self, kind: str) -> List[str]:
        val = self.spec.get(kind)
        if val is None:
            return []
        if isinstance(val, str):
            val = [val]
        return [str(v) for v in val if v]

    def _default_monitors(self, caps: Dict[str, Any]) -> List[str]:
        mons = self._selected("monitors")
        if mons:  # explicit selection (possibly empty → none)
            return mons
        for mon in caps.get("monitors", []):
            if mon.get("primary"):
                return [str(mon["id"])]
        return []

    def _capture_screen(self, monitor_ids: List[str]) -> None:
        """One capture thread PER MONITOR (each opens its own mss instance —
        mss is not thread-safe across threads, and per-monitor threads keep
        every selected monitor at the full RECORD_FPS_SCREEN)."""
        if not monitor_ids:
            return
        try:
            import mss  # type: ignore  # noqa: F401 - availability probe
        except Exception as exc:  # noqa: BLE001
            self.sink.add({"t": int(time.time() * 1000), "kind": "meta",
                           "event": "screen-unavailable", "error": str(exc)})
            return
        threads = [threading.Thread(target=self._capture_screen_one, args=(mon_id,),
                                    name=f"sentra-rec-scr-{mon_id}", daemon=True)
                   for mon_id in monitor_ids]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

    def _capture_screen_one(self, mon_id: str) -> None:
        interval = 1.0 / RECORD_FPS_SCREEN
        try:
            import mss  # type: ignore

            with mss.mss() as sct:
                monitors = list(sct.monitors)
                try:
                    idx = int(str(mon_id).split(":", 1)[1])
                except (ValueError, IndexError):
                    idx = 0
                mon = monitors[idx + 1] if idx + 1 < len(monitors) else (monitors[1] if len(monitors) > 1 else monitors[0])
                next_t = time.monotonic()
                while not self._cancel.is_set() and not self.global_stop.is_set() and self.state == "recording":
                    shot = sct.grab(mon)
                    data_b64 = _fit_jpeg_b64_bgra(shot.bgra, shot.width, shot.height)
                    self.sink.add({
                        "t": int(time.time() * 1000), "kind": "screen",
                        "sourceId": mon_id, "mime": "image/jpeg", "dataB64": data_b64,
                    })
                    next_t += interval
                    sleep = next_t - time.monotonic()
                    if sleep > 0:
                        time.sleep(sleep)
                    else:
                        next_t = time.monotonic()
        except Exception as exc:  # noqa: BLE001 - degrade to honest meta note
            self.sink.add({"t": int(time.time() * 1000), "kind": "meta",
                           "event": "screen-capture-error", "sourceId": mon_id, "error": str(exc)})

    def _capture_camera(self, camera_ids: List[str]) -> None:
        if not camera_ids:
            return
        try:
            import cv2  # type: ignore
        except Exception as exc:  # noqa: BLE001
            self.sink.add({"t": int(time.time() * 1000), "kind": "meta",
                           "event": "camera-unavailable", "error": str(exc)})
            return
        interval = 1.0 / RECORD_FPS_CAMERA
        for cam_id in camera_ids:
            try:
                idx = int(str(cam_id).split(":", 1)[1])
            except (ValueError, IndexError):
                idx = 0
            cap = cv2.VideoCapture(idx, getattr(cv2, "CAP_DSHOW", 0))
            try:
                if not cap.isOpened():
                    self.sink.add({"t": int(time.time() * 1000), "kind": "meta",
                                   "event": "camera-open-failed", "sourceId": cam_id})
                    continue
                next_t = time.monotonic()
                while not self._cancel.is_set() and not self.global_stop.is_set() and self.state == "recording":
                    ok, img = cap.read()
                    if not ok:
                        time.sleep(0.1)
                        continue
                    data_b64 = _fit_jpeg_img(img)
                    self.sink.add({
                        "t": int(time.time() * 1000), "kind": "camera",
                        "sourceId": cam_id, "mime": "image/jpeg", "dataB64": data_b64,
                    })
                    next_t += interval
                    sleep = next_t - time.monotonic()
                    if sleep > 0:
                        time.sleep(sleep)
                    else:
                        next_t = time.monotonic()
            except Exception as exc:  # noqa: BLE001
                self.sink.add({"t": int(time.time() * 1000), "kind": "meta",
                               "event": "camera-capture-error", "sourceId": cam_id, "error": str(exc)})
            finally:
                try:
                    cap.release()
                except Exception:  # noqa: BLE001
                    pass

    def _capture_mic(self, mic_ids: List[str]) -> None:
        if not mic_ids:
            return
        try:
            import numpy as np  # type: ignore
            import sounddevice as sd  # type: ignore
        except Exception as exc:  # noqa: BLE001
            self.sink.add({"t": int(time.time() * 1000), "kind": "meta",
                           "event": "mic-unavailable", "error": str(exc)})
            return
        interval = 1.0 / MIC_RECORD_HZ
        for mic_id in mic_ids:
            try:
                dev_idx: Optional[int] = None
                if str(mic_id).startswith("mic:"):
                    try:
                        dev_idx = int(str(mic_id).split(":", 1)[1])
                    except ValueError:
                        dev_idx = None
                latest = {"rms": 0.0}

                def cb(indata: Any, frames: int, time_info: Any, status: Any) -> None:
                    try:
                        mono = indata[:, 0].astype("float32")
                        latest["rms"] = min(1.0, max(0.0, float(np.sqrt(np.mean(np.square(mono)))) * 4.0))
                    except Exception:  # noqa: BLE001
                        pass

                with sd.InputStream(samplerate=16000, channels=1, dtype="float32",
                                    device=dev_idx, blocksize=1024, callback=cb):
                    next_t = time.monotonic()
                    while not self._cancel.is_set() and not self.global_stop.is_set() and self.state == "recording":
                        self.sink.add({"t": int(time.time() * 1000), "kind": "mic",
                                       "sourceId": mic_id, "level": round(latest["rms"], 4)})
                        next_t += interval
                        sleep = next_t - time.monotonic()
                        if sleep > 0:
                            time.sleep(sleep)
                        else:
                            next_t = time.monotonic()
            except Exception as exc:  # noqa: BLE001
                self.sink.add({"t": int(time.time() * 1000), "kind": "meta",
                               "event": "mic-capture-error", "sourceId": mic_id, "error": str(exc)})

    # ------------------------------------------------------------ encryption

    def _write_header(self, fh: io.BufferedWriter, sources: List[str]) -> bytes:
        header = {
            "magic": MAGIC, "cipher": CIPHER, "kdf": KDF,
            "iterations": KDF_ITERATIONS, "salt": base64.b64encode(self.salt).decode("ascii"),
            "agentId": self.agent_id, "recordingId": self.recording_id,
            "label": self.spec.get("label"),
            "durationSec": self.duration_sec, "sources": sources,
            "startedAt": self.started_at_ms,
        }
        line = (json.dumps(header, separators=(",", ":")) + "\n").encode("ascii")
        fh.write(line)
        return line

    def _encrypt_group(self, key: bytes, aad: bytes, plaintext: bytes) -> bytes:
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM

        nonce = os.urandom(12)
        sealed = AESGCM(key).encrypt(nonce, plaintext, aad)  # ct || tag
        ct, tag = sealed[:-16], sealed[-16:]
        frame = len(nonce) + len(ct) + len(tag)
        return frame.to_bytes(4, "big") + nonce + ct + tag

    # ------------------------------------------------------------------- run

    def run(self) -> None:
        try:
            self._run_inner()
        except Exception as exc:  # noqa: BLE001 - never let a job kill the process
            self.state = "failed"
            self.error = str(exc)
            log.exception("recording %s failed", self.recording_id)
            try:
                self.emit_status(self.status_msg())
            except Exception:  # noqa: BLE001
                pass
            try:
                self.transparency.recording_stop(self.spec.get("label"), "failed")
            except Exception:  # noqa: BLE001
                pass

    def _run_inner(self) -> None:
        from .captures import enumerate_captures

        caps = enumerate_captures()
        monitor_ids = self._default_monitors(caps)
        camera_ids = self._selected("cameras")
        mic_ids = self._selected("mics")
        sources = monitor_ids + camera_ids + mic_ids

        passphrase = str(self.spec.get("passphrase") or "")
        if not passphrase:
            raise ValueError("record:schedule payload is missing 'passphrase'")

        # (The user-facing armed notification already happened synchronously in
        #  RecordingManager.schedule — before the ack — per the v0.3 contract.)
        self.emit_status(self.status_msg())  # state=armed
        time.sleep(1.0)  # brief armed window so cancel() can land
        if self._cancel.is_set():
            self.state = "canceled"
            self.ended_at_ms = int(time.time() * 1000)
            self.emit_status(self.status_msg())
            try:
                self.transparency.recording_stop(self.spec.get("label"), "canceled")
            except Exception:  # noqa: BLE001
                pass
            return

        self.state = "recording"
        self.started_at_ms = int(time.time() * 1000)
        # provenance record FIRST — every artifact carries at least this, even
        # on headless boxes where no capture backend is available.
        self.sink.add({"t": self.started_at_ms, "kind": "meta",
                       "event": "recording-started", "sources": sources,
                       "agentId": self.agent_id})
        # MANDATORY on-screen overlay + red tray dot + toast (non-disableable)
        try:
            self.transparency.recording_start(
                self.spec.get("label") or None,
                str(self.spec["noticeText"]) if self.spec.get("noticeText") else None,
            )
        except Exception:  # noqa: BLE001
            log.exception("transparency recording_start failed")

        key = _derive_key(passphrase, self.salt)
        del passphrase  # do not keep it around
        aad = _aad_for(self.recording_id)

        try:
            fh = open(self.file_path, "wb")
        except OSError as exc:
            raise RuntimeError(f"cannot create recording file: {exc}") from exc

        group: List[bytes] = []
        group_size = 0
        chunk_buf: List[bytes] = []
        chunk_size = 0

        def flush_group() -> None:
            nonlocal group, group_size, chunk_buf, chunk_size
            if not group:
                return
            plaintext = b"\n".join(group) + b"\n"
            frame = self._encrypt_group(key, aad, plaintext)
            fh.write(frame)
            self.size_bytes += len(frame)
            self.frames += len(group)
            group = []
            group_size = 0
            # hard-contract guard: never let one chunk payload cross CHUNK_MAX
            if chunk_buf and chunk_size + len(frame) > CHUNK_MAX - 1024:
                self._emit_chunk(chunk_buf)
                chunk_buf = []
                chunk_size = 0
            chunk_buf.append(frame)
            chunk_size += len(frame)
            if chunk_size >= CHUNK_TARGET:
                self._emit_chunk(chunk_buf)
                chunk_buf = []
                chunk_size = 0

        # start capture threads (daemon — die with the process)
        for target, args in (
            (self._capture_screen, (monitor_ids,)),
            (self._capture_camera, (camera_ids,)),
            (self._capture_mic, (mic_ids,)),
        ):
            t = threading.Thread(target=target, args=args, daemon=True)
            t.start()
            self.capture_threads.append(t)

        end_at = time.monotonic() + self.duration_sec
        last_progress = time.monotonic()
        try:
            header_line = self._write_header(fh, sources)
            self.size_bytes = fh.tell()
            # the header MUST travel through record:chunk too, so the hub-side
            # assembled file is byte-identical to the local one (seq is 0-based)
            self._emit_chunk([header_line])
            while True:
                time.sleep(0.15)
                records = self.sink.drain()
                for rec in records:
                    line = json.dumps(rec, separators=(",", ":")).encode("utf-8")
                    group.append(line)
                    group_size += len(line)
                    if group_size >= GROUP_BYTES:
                        flush_group()
                now = time.monotonic()
                if now - last_progress >= 15.0:
                    last_progress = now
                    self.emit_status(self.status_msg())
                    try:  # retry any chunks spooled earlier in this recording
                        self.uploader.flush_spool()
                    except Exception:  # noqa: BLE001
                        pass
                if self._cancel.is_set() or self.global_stop.is_set() or now >= end_at:
                    break
            flush_group()
            self.sink.add({"t": int(time.time() * 1000), "kind": "meta",
                           "event": "recording-ended",
                           "state": "canceled" if self._cancel.is_set() else "duration-reached"})
            for rec in self.sink.drain():  # pick up the end-of-recording record
                group.append(json.dumps(rec, separators=(",", ":")).encode("utf-8"))
            flush_group()
            if chunk_buf:
                self._emit_chunk(chunk_buf)
        finally:
            try:
                fh.flush()
                os.fsync(fh.fileno())
            except OSError:
                pass
            fh.close()

        self.ended_at_ms = int(time.time() * 1000)
        self.state = "canceled" if self._cancel.is_set() else "completed"
        self.emit_status(self.status_msg())
        try:
            self.transparency.recording_stop(self.spec.get("label"), self.state)
        except Exception:  # noqa: BLE001
            log.exception("transparency recording_stop failed")

        if self.state == "completed":
            sha = self._sha256_file(self.file_path)
            manifest = {
                "recordingId": self.recording_id,
                "fileName": os.path.basename(self.file_path),
                "sizeBytes": self.size_bytes,
                "sha256": sha,
            }
            # The last data chunk may still be in flight inside the uploader,
            # and the hub may even be unreachable: retry the manifest for up to
            # ~60s. The manager keeps UN-acked manifests and re-sends them on
            # every reconnect, so an offline-finished recording still seals.
            ok = False
            for _attempt in range(30):
                ok, _err = self.emit_manifest(manifest)
                if ok:
                    break
                time.sleep(2.0)
            log.info("recording %s completed: %s bytes, manifest ack=%s",
                     self.recording_id, self.size_bytes, ok)

    def _emit_chunk(self, frames: List[bytes]) -> None:
        payload = b"".join(frames)
        seq = self.seq  # 0-based, strictly ordered (hub expects `expected++`)
        self.seq += 1
        if len(payload) > CHUNK_MAX:
            # contract cap violated (single huge frame) — split is impossible in
            # this format, so log loudly; flush_group's guard prevents this path.
            log.error("chunk %s seq=%d exceeds %dKB (%d) — dropping", self.recording_id,
                      seq, CHUNK_MAX // 1024, len(payload))
            return
        self.uploader.submit(self.recording_id, seq, payload)

    @staticmethod
    def _sha256_file(path: str) -> str:
        h = hashlib.sha256()
        with open(path, "rb") as fh:
            for block in iter(lambda: fh.read(65536), b""):
                h.update(block)
        return h.hexdigest()


class RecordingManager:
    """Handles record:schedule / record:cancel / record:status for the hub."""

    def __init__(self, agent_id: str, cfg: Dict[str, Any], recordings_dir: str,
                 transparency: Any, is_connected: Callable[[], bool],
                 emit_chunk: Callable[[str, Dict[str, Any]], Tuple[bool, str]],
                 emit_status: Callable[[Dict[str, Any]], None],
                 emit_manifest: Callable[[Dict[str, Any]], Tuple[bool, str]]) -> None:
        self.agent_id = agent_id
        self.cfg = cfg
        self.recordings_dir = recordings_dir
        self.transparency = transparency
        self.uploader = _ChunkUploader(recordings_dir, is_connected, emit_chunk, emit_status)
        self.jobs: Dict[str, RecordingJob] = {}
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self.emit_status_fn = emit_status
        self.emit_manifest_fn = emit_manifest
        # manifest payloads the hub has NOT acked yet (offline completion /
        # tail-chunk race) — re-sent on every reconnect until acked.
        self._pending_manifests: Dict[str, Dict[str, Any]] = {}

    # ------------------------------------------------------------- handlers

    def schedule(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        """Validate + accept a record:schedule. Raises ValueError on bad input.

        MANDATORY transparency: the device user is notified HERE, before the
        ack is sent, using ``noticeText`` when the operator provided one.
        """
        recording_id = str(payload.get("recordingId") or "").strip()
        if not recording_id:
            raise ValueError("recordingId is required")
        duration_sec = int(payload.get("durationSec") or 0)
        max_sec = int(self.cfg.get("maxRecordingMin", 60)) * 60
        if duration_sec <= 0:
            raise ValueError("durationSec must be positive")
        if duration_sec > max_sec:
            raise ValueError(
                f"durationSec {duration_sec} exceeds this agent's maxRecordingMin cap "
                f"({max_sec}s) — adjust maxRecordingMin in config.json"
            )
        usage = shutil.disk_usage(self.recordings_dir)
        free_mb = int(usage.free / (1024 * 1024))
        if free_mb < int(self.cfg.get("minFreeMB", 500)):
            raise ValueError(
                f"insufficient disk space for recording ({free_mb}MB free < "
                f"minFreeMB {self.cfg.get('minFreeMB')}MB)"
            )
        with self._lock:
            alive = [j for j in self.jobs.values() if j.is_alive()]
            if len(alive) >= MAX_CONCURRENT:
                raise ValueError(f"agent already has {len(alive)} recordings in progress (cap {MAX_CONCURRENT})")

        # ── notify the device user synchronously BEFORE the ack (contract) ──
        label = payload.get("label") or "recording"
        notice_text = str(payload["noticeText"]) if payload.get("noticeText") else None
        try:
            self.transparency.notifier.recording_armed(str(label), duration_sec, notice_text)
            self.transparency.remote_action(
                "record", f"Recording session scheduled ({duration_sec}s)"
                + (f" — {payload.get('label')}" if payload.get("label") else ""),
            )
        except Exception:  # noqa: BLE001 - transparency must never break recording
            log.exception("transparency armed-notify failed")

        job = RecordingJob(
            dict(payload), self.agent_id, self.recordings_dir, self.uploader,
            self.emit_status_fn, self._emit_manifest_tracked,
            self.transparency, self._stop,
        )
        with self._lock:
            self.jobs[recording_id] = job
        job.start()
        return {"accepted": True, "state": job.state}

    def cancel(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        recording_id = str(payload.get("recordingId") or "")
        with self._lock:
            job = self.jobs.get(recording_id)
        if job is None:
            raise ValueError(f"unknown recordingId '{recording_id}'")
        try:  # MANDATORY transparency: the user sees the cancellation too
            self.transparency.remote_action("record", f"Recording {recording_id} canceled by operator")
        except Exception:  # noqa: BLE001
            pass
        job.cancel()
        return {"ok": True}

    def status(self) -> Dict[str, Any]:
        return {"recordings": self.job_statuses()}

    def job_statuses(self) -> List[Dict[str, Any]]:
        """Status payloads of all live/recent jobs (public — RFT-safe)."""
        with self._lock:
            jobs = [j for j in self.jobs.values() if j.is_alive() or j.state in ("armed", "recording")]
        return [j.status_msg() for j in jobs]

    # ------------------------------------------------------------------ misc

    def _emit_manifest_tracked(self, payload: Dict[str, Any]) -> Tuple[bool, str]:
        """emit record:manifest AND remember un-acked payloads for reconnect."""
        ok, err = self.emit_manifest_fn(payload)
        rid = str(payload.get("recordingId") or "")
        with self._lock:
            if ok:
                self._pending_manifests.pop(rid, None)
            elif rid:
                self._pending_manifests[rid] = dict(payload)
        return ok, err

    def on_reconnect(self) -> None:
        """After the hub link comes back: flush spooled chunks + re-emit state
        + re-send any manifests the hub never acked."""
        try:
            for msg in self.job_statuses():
                try:
                    self.emit_status_fn(msg)
                except Exception:  # noqa: BLE001
                    pass
        except Exception:  # noqa: BLE001
            log.exception("status re-emit on reconnect failed")
        try:
            sent = self.uploader.flush_spool()
            if sent:
                log.info("flushed %d spooled recording chunk(s) after reconnect", sent)
        except Exception:  # noqa: BLE001
            log.exception("spool flush failed")
        try:  # chunks first (above), THEN the manifests that depend on them
            with self._lock:
                pending = list(self._pending_manifests.values())
            for payload in pending:
                ok, _err = self._emit_manifest_tracked(payload)
                if ok:
                    log.info("re-sent recording manifest %s after reconnect",
                             payload.get("recordingId"))
        except Exception:  # noqa: BLE001
            log.exception("manifest re-send on reconnect failed")

    def stop_all(self) -> None:
        self._stop.set()
        with self._lock:
            jobs = list(self.jobs.values())
        for job in jobs:
            job.cancel()
        for job in jobs:
            job.join(timeout=5.0)
        self.uploader.stop()
