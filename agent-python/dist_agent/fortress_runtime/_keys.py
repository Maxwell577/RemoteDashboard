"""PyFortress per-build runtime keys (obfuscated embedding).

NOTE: in the pure-Python tier these keys are obfuscated, not unextractable.
Use --native (Cython) to compile this file to machine code.
"""
import base64

_PAD = b"\x40\xea\x11\xfe\x4f\x70\x12\xbc\x6b\x78\x58\x9c\xcb\xc6\xcf\x51"
_K1 = "02%`vIWEH8Q0;#M{;5L2k9qI;hc#{d0B#Twc>)jE"
_K2 = "EDG<1IOPAK5i-5*kA5)1$}NrAaL9d8*^Ca+5c(Mh"


def _revive(blob):
    raw = base64.b85decode(blob.encode("ascii"))
    return bytes((a ^ b) for a, b in zip(raw, (_PAD * 32)[: len(raw)]))


def get_keys():
    return _revive(_K1), _revive(_K2)
