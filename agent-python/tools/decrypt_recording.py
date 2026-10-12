#!/usr/bin/env python3
"""Decrypt a SENTRA-REC-1 encrypted recording (.enc) produced by SentraRMM agents.

File format (frozen in src/lib/types.ts, v0.3):
    Line 1: JSON header { magic: "SENTRA-REC-1", cipher, kdf, iterations,
                          salt(b64 16B), agentId, label?, durationSec,
                          sources: [...], startedAt }
    Then framed records: [u32 BE length][12B nonce][ciphertext][16B tag]
      plaintext = JSON { t, kind: "screen"|"camera"|"mic"|"meta",
                         sourceId?, mime?, dataB64?, level? }
    key  = PBKDF2-HMAC-SHA256(passphrase, salt, iterations, 32 bytes)
    AAD  = first 16 bytes of sha256(recordingId)

Usage:
    python decrypt_recording.py RECORDING.enc --passphrase '...' [--out DIR]
    python decrypt_recording.py RECORDING.enc --list
    python decrypt_recording.py RECORDING.enc --passphrase '...' --verify SHA256

Output (default ./<file>-decrypted/):
    frame_%06d.jpg   screen/camera JPEG frames (kind recorded in manifest.json)
    levels.csv       mic level samples (t_iso, sourceId, level)
    manifest.json    header + decryption summary + meta records
"""
from __future__ import annotations

import argparse
import base64
import getpass
import hashlib
import json
import os
import struct
import sys
import time
from typing import Any, Dict, Iterator, List, Optional, Tuple

MAGIC = "SENTRA-REC-1"


class DecryptError(Exception):
    """User-facing decryption error."""


def parse_header(path: str) -> Dict[str, Any]:
    """Read line 1 and validate the header; returns the header dict + file offset."""
    with open(path, "rb") as fh:
        line = fh.readline()
    if not line:
        raise DecryptError("file is empty")
    try:
        header = json.loads(line.decode("ascii").strip())
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise DecryptError(f"header is not valid JSON: {exc}") from exc
    if not isinstance(header, dict) or header.get("magic") != MAGIC:
        raise DecryptError(f"not a {MAGIC} recording (bad or missing magic)")
    return header


def derive_key(header: Dict[str, Any], passphrase: str) -> bytes:
    try:
        salt = base64.b64decode(str(header.get("salt", "")), validate=True)
        iterations = int(header.get("iterations", 200000))
    except Exception as exc:  # noqa: BLE001
        raise DecryptError(f"malformed header salt/iterations: {exc}") from exc
    if len(salt) != 16:
        raise DecryptError(f"expected a 16-byte salt, got {len(salt)} bytes")
    return hashlib.pbkdf2_hmac("sha256", passphrase.encode("utf-8"), salt, iterations, dklen=32)


def iter_frames(path: str) -> Iterator[Tuple[bytes, bytes, bytes]]:
    """Yield (nonce, ciphertext, tag) tuples."""
    with open(path, "rb") as fh:
        fh.readline()  # skip header line
        while True:
            len_bytes = fh.read(4)
            if not len_bytes:
                return
            if len(len_bytes) < 4:
                raise DecryptError("truncated frame length field (corrupted file)")
            (frame_len,) = struct.unpack(">I", len_bytes)
            body = fh.read(frame_len)
            if len(body) < frame_len:
                raise DecryptError("truncated frame body (corrupted file)")
            if frame_len < 12 + 16:
                raise DecryptError(f"frame too small ({frame_len} bytes)")
            nonce, ct, tag = body[:12], body[12:-16], body[-16:]
            yield nonce, ct, tag


def decrypt_all(path: str, header: Dict[str, Any], key: bytes, aad: bytes):
    """Yield decrypted plaintext record dicts; raises DecryptError on InvalidTag."""
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    from cryptography.exceptions import InvalidTag

    aes = AESGCM(key)
    for nonce, ct, tag in iter_frames(path):
        try:
            pt = aes.decrypt(nonce, ct + tag, aad)
        except InvalidTag as exc:
            raise DecryptError(
                "wrong passphrase or corrupted file (AES-GCM authentication failed)"
            ) from exc
        for line in pt.split(b"\n"):
            line = line.strip()
            if not line:
                continue
            try:
                yield json.loads(line.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                raise DecryptError(f"decrypted record is not valid JSON: {exc}") from exc


def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for block in iter(lambda: fh.read(1 << 16), b""):
            h.update(block)
    return h.hexdigest()


def main(argv: Optional[List[str]] = None) -> int:
    ap = argparse.ArgumentParser(description="Decrypt a SENTRA-REC-1 .enc recording")
    ap.add_argument("file", help="path to <recordingId>.enc")
    ap.add_argument("--passphrase", "-p", default=None,
                    help="recording passphrase (prompted if omitted)")
    ap.add_argument("--out", "-o", default=None, help="output directory")
    ap.add_argument("--list", action="store_true",
                    help="print header info only (no passphrase needed)")
    ap.add_argument("--verify", default=None, metavar="SHA256",
                    help="verify the file's sha256 before decrypting")
    args = ap.parse_args(argv)

    path = os.path.abspath(args.file)
    if not os.path.isfile(path):
        print(f"error: file not found: {path}", file=sys.stderr)
        return 2

    if args.verify:
        actual = sha256_file(path)
        if actual.lower() != args.verify.lower():
            print(f"error: sha256 mismatch\n  expected {args.verify}\n  actual   {actual}",
                  file=sys.stderr)
            return 1
        print(f"sha256 verified: {actual}")

    try:
        header = parse_header(path)
    except DecryptError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    header["_path"] = path

    if args.list:
        printable = {k: v for k, v in header.items() if not k.startswith("_")}
        print(json.dumps(printable, indent=2))
        return 0

    passphrase = args.passphrase or getpass.getpass("Recording passphrase: ")
    if not passphrase:
        print("error: a passphrase is required", file=sys.stderr)
        return 2

    # recordingId for AAD: prefer header, fall back to the filename stem
    rid = str(header.get("recordingId") or "")
    if not rid:
        rid = os.path.splitext(os.path.basename(path))[0]
        header["recordingId"] = rid
    aad = hashlib.sha256(rid.encode("utf-8")).digest()[:16]

    try:
        key = derive_key(header, passphrase)
    except DecryptError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    out_dir = args.out or os.path.splitext(path)[0] + "-decrypted"
    os.makedirs(out_dir, exist_ok=True)

    frames: List[Dict[str, Any]] = []
    levels: List[Dict[str, Any]] = []
    metas: List[Dict[str, Any]] = []
    counter = 0
    try:
        for rec in decrypt_all(path, header, key, aad):
            kind = str(rec.get("kind", ""))
            data_b64 = rec.get("dataB64")
            if kind in ("screen", "camera") and data_b64:
                counter += 1
                frame_name = f"frame_{counter:06d}.jpg"
                try:
                    with open(os.path.join(out_dir, frame_name), "wb") as fh:
                        fh.write(base64.b64decode(data_b64, validate=True))
                except Exception as exc:  # noqa: BLE001 - bad base64 in one frame
                    print(f"warning: could not write {frame_name}: {exc}", file=sys.stderr)
                    counter -= 1
                    continue
                frames.append({"file": frame_name, "kind": kind,
                               "sourceId": rec.get("sourceId"), "t": rec.get("t")})
            elif kind == "mic":
                levels.append({"t": rec.get("t"), "sourceId": rec.get("sourceId"),
                               "level": rec.get("level")})
            elif kind == "meta":
                metas.append(rec)
    except DecryptError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    except OSError as exc:
        print(f"error: cannot read recording: {exc}", file=sys.stderr)
        return 1

    # clean up a possible partially-written frame if nothing was recoverable
    if counter == 0 and not levels and not metas:
        print("warning: no records were recovered", file=sys.stderr)

    with open(os.path.join(out_dir, "levels.csv"), "w", encoding="utf-8") as fh:
        fh.write("t_iso,sourceId,level\n")
        for row in levels:
            t = row.get("t")
            t_iso = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime((t or 0) / 1000)) if t else ""
            fh.write(f"{t_iso},{row.get('sourceId', '')},{row.get('level', '')}\n")

    manifest = {
        "header": {k: v for k, v in header.items() if not k.startswith("_")},
        "decryptedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "sha256": sha256_file(path),
        "summary": {"frames": len(frames), "micLevels": len(levels), "metaRecords": len(metas)},
        "frames": frames,
        "meta": metas,
    }
    with open(os.path.join(out_dir, "manifest.json"), "w", encoding="utf-8") as fh:
        json.dump(manifest, fh, indent=2)
        fh.write("\n")

    print(f"ok: {len(frames)} frame(s), {len(levels)} mic level(s), {len(metas)} meta record(s)")
    print(f"output: {out_dir}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
