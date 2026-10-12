"""Encrypted container format for PyFortress payloads.

Layout: MAGIC(4) | VERSION(1) | FLAGS(1) | NONCE(12) | CTLEN(4 LE) | CT | HMAC-SHA256(32)
Cipher: ChaCha20 (pure stdlib). Integrity: encrypt-then-MAC (HMAC-SHA256 over
header+ciphertext), so any tampering is detected before code is unmarshalled.
"""
import hashlib
import hmac
import os
import struct

from . import chacha20

MAGIC = b"PFXC"
VERSION = 1
HEADER_LEN = 22  # 4 + 1 + 1 + 12 + 4
MAC_LEN = 32

FLAG_OBF_MODULE = 1


class ContainerError(Exception):
    pass


def pack(payload, key, mac_key, flags=0):
    nonce = os.urandom(12)
    ct = chacha20.xor(key, nonce, payload)
    header = MAGIC + bytes([VERSION, flags & 0xFF]) + nonce + struct.pack("<I", len(ct))
    mac = hmac.new(mac_key, header + ct, hashlib.sha256).digest()
    return header + ct + mac


def unpack(blob, key, mac_key):
    if not isinstance(blob, (bytes, bytearray)):
        raise ContainerError("container must be bytes")
    blob = bytes(blob)
    if len(blob) < HEADER_LEN + MAC_LEN:
        raise ContainerError("container too short")
    if blob[:4] != MAGIC:
        raise ContainerError("bad magic: not a PyFortress container")
    version = blob[4]
    if version != VERSION:
        raise ContainerError("unsupported container version %d" % version)
    flags = blob[5]
    nonce = blob[6:18]
    (ctlen,) = struct.unpack("<I", blob[18:HEADER_LEN])
    ct = blob[HEADER_LEN:HEADER_LEN + ctlen]
    if len(ct) != ctlen:
        raise ContainerError("truncated container")
    mac = blob[HEADER_LEN + ctlen:HEADER_LEN + ctlen + MAC_LEN]
    expect = hmac.new(mac_key, blob[:HEADER_LEN + ctlen], hashlib.sha256).digest()
    if not hmac.compare_digest(mac, expect):
        raise ContainerError("integrity check failed: container was modified")
    payload = chacha20.xor(key, nonce, ct)
    return flags, payload


def enc_str(key, s):
    """Encrypt a str/bytes constant for mix-str. Returns ascii b85 blob."""
    # 4 fresh bytes stored for uniqueness; padded to the 12-byte ChaCha20 nonce.
    nonce4 = os.urandom(4)
    if isinstance(s, str):
        data = b"\x00" + s.encode("utf-8")
    elif isinstance(s, bytes):
        data = b"\x01" + s
    else:
        raise TypeError("enc_str supports str/bytes only")
    ct = chacha20.xor(key, _pad_nonce(nonce4), data)
    import base64
    return base64.b85encode(nonce4 + ct).decode("ascii")


def _pad_nonce(nonce4):
    return nonce4 + b"\x00" * 8


def dec_str(key, blob):
    import base64
    raw = base64.b85decode(blob.encode("ascii"))
    nonce4, ct = raw[:4], raw[4:]
    data = chacha20.xor(key, _pad_nonce(nonce4), ct)
    if data[:1] == b"\x00":
        return data[1:].decode("utf-8")
    return bytes(data[1:])
