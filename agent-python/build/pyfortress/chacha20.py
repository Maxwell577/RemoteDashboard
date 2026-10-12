"""Pure-stdlib ChaCha20 stream cipher + HKDF-SHA256.

Shared by the build tool and the generated runtime so protected programs
need no third-party packages on target machines. RFC 8439.
"""
import hashlib
import hmac as _hmac
import struct

_MASK = 0xFFFFFFFF


def _rotl(v, c):
    return ((v << c) & _MASK) | (v >> (32 - c))


def _quarter(s, a, b, c, d):
    s[a] = (s[a] + s[b]) & _MASK; s[d] ^= s[a]; s[d] = _rotl(s[d], 16)
    s[c] = (s[c] + s[d]) & _MASK; s[b] ^= s[c]; s[b] = _rotl(s[b], 12)
    s[a] = (s[a] + s[b]) & _MASK; s[d] ^= s[a]; s[d] = _rotl(s[d], 8)
    s[c] = (s[c] + s[d]) & _MASK; s[b] ^= s[c]; s[b] = _rotl(s[b], 7)


def _block(key32, counter, nonce12):
    state = [0x61707865, 0x3320646E, 0x79622D32, 0x6B206574] + list(key32) + [counter] + list(nonce12)
    w = list(state)
    for _ in range(10):
        _quarter(w, 0, 4, 8, 12); _quarter(w, 1, 5, 9, 13)
        _quarter(w, 2, 6, 10, 14); _quarter(w, 3, 7, 11, 15)
        _quarter(w, 0, 5, 10, 15); _quarter(w, 1, 6, 11, 12)
        _quarter(w, 2, 7, 8, 13); _quarter(w, 3, 4, 9, 14)
    return struct.pack("<16I", *[(w[i] + state[i]) & _MASK for i in range(16)])


def keystream(key, nonce, length):
    if len(key) != 32:
        raise ValueError("chacha20 key must be 32 bytes")
    if len(nonce) != 12:
        raise ValueError("chacha20 nonce must be 12 bytes")
    key32 = struct.unpack("<8I", key)
    n3 = struct.unpack("<3I", nonce)
    out = bytearray()
    counter = 0
    while len(out) < length:
        out += _block(key32, counter, n3)
        counter = (counter + 1) & _MASK
    return bytes(out[:length])


def xor(key, nonce, data):
    ks = keystream(key, nonce, len(data))
    return bytes(a ^ b for a, b in zip(data, ks))


def hkdf(master, info, length=32):
    """RFC 5869 HKDF-SHA256 with a fixed application salt."""
    prk = _hmac.new(b"pyfortress/hkdf/salt", master, hashlib.sha256).digest()
    okm = b""
    t = b""
    i = 1
    while len(okm) < length:
        t = _hmac.new(prk, t + info + bytes([i]), hashlib.sha256).digest()
        okm += t
        i += 1
    return okm[:length]
