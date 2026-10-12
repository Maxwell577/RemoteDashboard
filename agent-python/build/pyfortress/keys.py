"""Per-build key material, license blob and runtime key file generation."""
import base64
import calendar
import hashlib
import json
import os
import re
import time
from datetime import datetime

from . import chacha20, container


def new_secrets():
    return os.urandom(32), os.urandom(32)


def module_code_key(master, modname):
    return chacha20.hkdf(master, b"module:" + modname.encode("utf-8"))


def module_str_key(master, modname):
    return chacha20.hkdf(master, b"strings:" + modname.encode("utf-8"))


def license_enc_key(mack):
    return chacha20.hkdf(mack, b"license")


def obfuscate_embed(secret, pad=None):
    """XOR-obfuscate a key for embedding in the runtime package."""
    pad = pad or os.urandom(16)
    xored = bytes(a ^ b for a, b in zip(secret, (pad * 32)[: len(secret)]))
    return pad, base64.b85encode(xored).decode("ascii")


def revive(b85, pad):
    raw = base64.b85decode(b85.encode("ascii"))
    return bytes(a ^ b for a, b in zip(raw, (pad * 32)[: len(raw)]))


KEYS_TEMPLATE = '''"""PyFortress per-build runtime keys (obfuscated embedding).

NOTE: in the pure-Python tier these keys are obfuscated, not unextractable.
Use --native (Cython) to compile this file to machine code.
"""
import base64

_PAD = b"%(pad)s"
_K1 = "%(k1)s"
_K2 = "%(k2)s"


def _revive(blob):
    raw = base64.b85decode(blob.encode("ascii"))
    return bytes((a ^ b) for a, b in zip(raw, (_PAD * 32)[: len(raw)]))


def get_keys():
    return _revive(_K1), _revive(_K2)
'''


def render_keys_module(master, mack):
    pad_m, k1 = obfuscate_embed(master)
    pad_l, k2 = obfuscate_embed(mack, pad_m)
    # both halves share one pad for a smaller file
    xored = bytes(a ^ b for a, b in zip(mack, (pad_m * 32)[: len(mack)]))
    k2 = base64.b85encode(xored).decode("ascii")
    return KEYS_TEMPLATE % {"pad": "".join("\\x%02x" % b for b in pad_m), "k1": k1, "k2": k2}


def parse_expire(spec):
    """'-e 30' -> epoch now+30d; '-e 2026-12-31' -> epoch of that date (local)."""
    if spec is None:
        return None
    spec = str(spec).strip()
    if re.fullmatch(r"\d+(?:\.\d+)?", spec):
        return time.time() + float(spec) * 86400
    m = re.fullmatch(r"(\d{4})-(\d{2})-(\d{2})", spec)
    if m:
        dt = datetime(int(m.group(1)), int(m.group(2)), int(m.group(3)), 23, 59, 59)
        return calendar.timegm(dt.timetuple())
    raise ValueError("invalid --expired value: %r (use days or YYYY-MM-DD)" % spec)


def parse_period(spec):
    if not spec:
        return 0
    spec = str(spec).strip().lower()
    m = re.fullmatch(r"(\d+)([smh]?)", spec)
    if not m:
        raise ValueError("invalid --period value: %r (use 30s / 10m / 2h)" % spec)
    n, unit = int(m.group(1)), m.group(2) or "h"
    return n * {"s": 1, "m": 60, "h": 3600}[unit]


def build_license_blob(mack, *, expires=None, devices=(), bind_data=None, period=0):
    data = {
        "expires": expires,
        "devices": sorted(hashlib.sha256(d.encode("utf-8", "replace")).hexdigest()
                          for d in devices),
        "bind_data": bind_data,
        "period": int(period or 0),
    }
    payload = json.dumps(data, sort_keys=True).encode("utf-8")
    return container.pack(payload, license_enc_key(mack), mack)


def license_required(*, expires, devices, bind_data, period, outer):
    return bool(expires or devices or bind_data is not None or period or outer)
