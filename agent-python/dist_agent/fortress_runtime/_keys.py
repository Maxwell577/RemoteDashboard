"""PyFortress per-build runtime keys (obfuscated embedding).

NOTE: in the pure-Python tier these keys are obfuscated, not unextractable.
Use --native (Cython) to compile this file to machine code.
"""
import base64

_PAD = b"\xf9\xe2\x94\xea\x3f\x12\x64\xba\x34\x38\x0b\x9a\x0b\xee\x8f\xbd"
_K1 = "CAX>co!r3`1C@BMJyc_tDEZ?s6(DtK*ZvEtMoC5g"
_K2 = "dQmsY`a+_Eh!)p`=VUxCv~-J1=rf&Kn4FovywR&K"


def _revive(blob):
    raw = base64.b85decode(blob.encode("ascii"))
    return bytes((a ^ b) for a, b in zip(raw, (_PAD * 32)[: len(raw)]))


def get_keys():
    return _revive(_K1), _revive(_K2)
