"""License enforcement: expiry, device binding, bind-data, periodic re-check."""
import base64
import json
import os
import sys
import threading
import time

from . import container as _container
from .chacha20 import hkdf as _hkdf

_KEYNAME = "fortress.key"
_STATE = {"data": None, "timer": None}


class FortressLicenseError(RuntimeError):
    pass


def load_blob():
    try:
        from ._lic import _LIC
        if _LIC:
            return base64.b85decode(_LIC.encode("ascii"))
    except Exception:
        pass
    cands = []
    env = os.environ.get("PYFORTRESS_RKEY")
    if env:
        cands.append(env)
    cands.append(os.path.join(os.path.dirname(os.path.abspath(__file__)), _KEYNAME))
    cands.append(os.path.join(os.getcwd(), _KEYNAME))
    cands.append(sys.executable + "." + _KEYNAME)
    for p in cands:
        try:
            if p and os.path.isfile(p):
                with open(p, "rb") as f:
                    return f.read()
        except Exception:
            pass
    return None


def decrypt_blob(blob, mack):
    lic_key = _hkdf(mack, b"license")
    _flags, payload = _container.unpack(blob, lic_key, mack)
    return json.loads(payload.decode("utf-8"))


def check_all(mack, require):
    if not require:
        return
    blob = load_blob()
    if blob is None:
        raise FortressLicenseError("license key not found")
    try:
        data = decrypt_blob(blob, mack)
    except Exception:
        raise FortressLicenseError("invalid license key")
    _STATE["data"] = data
    _verify(data)
    period = int(data.get("period") or 0)
    if period > 0 and _STATE["timer"] is None:
        t = threading.Thread(target=_periodic, args=(period,), daemon=True)
        _STATE["timer"] = t
        t.start()


def _verify(data):
    expires = data.get("expires")
    if expires and time.time() > float(expires):
        raise FortressLicenseError("license expired")
    devices = data.get("devices") or []
    if devices:
        from . import hdinfo
        have = hdinfo.fingerprint_hashes()
        if not (set(devices) & have):
            raise FortressLicenseError("unauthorized device")


def _periodic(secs):
    while True:
        time.sleep(secs)
        data = _STATE.get("data")
        if data:
            try:
                _verify(data)
            except BaseException:
                os.write(2, b"unauthorized use of script\n")
                os._exit(70)


def get_bind_data():
    data = _STATE.get("data")
    if not data:
        return None
    return data.get("bind_data")
