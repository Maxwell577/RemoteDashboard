#!/usr/bin/env python3
"""Generate a synthetic SENTRA-REC-1 .enc file (2 screen frames + 5 mic levels)."""
import base64, hashlib, json, os, struct, time

RECORDING_ID = "testrec-synthetic-0001"
PASSPHRASE = "test-pass-123"
OUT = "/home/z/my-project/.qa-tmp/testrec-synthetic-0001.enc"

TINY_JPEG_B64 = (
    "/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a"
    "HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIy"
    "MjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIA"
    "AhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQA"
    "AAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3"
    "ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWm"
    "p6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9oADAMB"
    "AAIRAxEAPwD3+iiigD//2Q==")

salt = os.urandom(16)
key = hashlib.pbkdf2_hmac("sha256", PASSPHRASE.encode(), salt, 200000, dklen=32)
aad = hashlib.sha256(RECORDING_ID.encode()).digest()[:16]

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

records = []
now = int(time.time() * 1000)
records.append({"t": now, "kind": "meta", "event": "recording-started", "label": "synthetic"})
for i in range(2):
    records.append({"t": now + 500 * (i + 1), "kind": "screen", "sourceId": "monitor:0",
                    "mime": "image/jpeg", "dataB64": TINY_JPEG_B64})
for i in range(5):
    records.append({"t": now + 1000 + i * 250, "kind": "mic", "sourceId": "mic:0",
                    "level": round(0.05 + 0.1 * i, 4)})
records.append({"t": now + 3000, "kind": "meta", "event": "recording-ended", "state": "completed"})

with open(OUT, "wb") as fh:
    header = {
        "magic": "SENTRA-REC-1", "cipher": "AES-256-GCM", "kdf": "PBKDF2-HMAC-SHA256",
        "iterations": 200000, "salt": base64.b64encode(salt).decode(),
        "agentId": "py-test", "recordingId": RECORDING_ID, "label": "synthetic test",
        "durationSec": 5, "sources": ["monitor:0", "mic:0"], "startedAt": now,
    }
    fh.write((json.dumps(header) + "\n").encode("ascii"))
    for rec in records:
        pt = (json.dumps(rec) + "\n").encode("utf-8")
        nonce = os.urandom(12)
        sealed = AESGCM(key).encrypt(nonce, pt, aad)
        frame = 12 + len(sealed)
        fh.write(struct.pack(">I", frame) + nonce + sealed)

print("wrote", OUT, os.path.getsize(OUT), "bytes,", len(records), "records")
