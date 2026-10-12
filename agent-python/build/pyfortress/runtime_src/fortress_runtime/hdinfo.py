"""Hardware/environment fingerprint collection. Self-contained (no relative imports)."""
import hashlib
import os
import platform
import socket
import subprocess
import uuid

_CACHE = {}


def _run(cmd, timeout=10):
    try:
        out = subprocess.run(
            cmd, capture_output=True, timeout=timeout,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        if out.returncode == 0:
            return out.stdout.decode("utf-8", "replace").strip()
    except Exception:
        pass
    return ""


def get_mac():
    node = uuid.getnode()
    return ":".join("%02x" % ((node >> (8 * i)) & 0xFF) for i in range(5, -1, -1))


def get_ipv4():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            s.connect(("8.8.8.8", 80))
            return s.getsockname()[0]
        finally:
            s.close()
    except Exception:
        try:
            return socket.gethostbyname(socket.gethostname())
        except Exception:
            return ""


def get_disk_serials():
    if "disk" in _CACHE:
        return _CACHE["disk"]
    serials = []
    if platform.system() == "Windows":
        out = _run(["powershell", "-NoProfile", "-Command",
                    "(Get-CimInstance Win32_DiskDrive | Where-Object SerialNumber).SerialNumber"], 20)
        if not out:
            out = _run(["wmic", "diskdrive", "get", "SerialNumber"], 20)
        for line in out.splitlines():
            line = line.strip()
            if line and "SerialNumber" not in line:
                serials.append(line)
        if not serials:
            try:
                import ctypes
                for letter in "CDEFGH":
                    vol = ctypes.create_unicode_buffer(261)
                    fs = ctypes.create_unicode_buffer(261)
                    serial = ctypes.c_ulong(0)
                    ok = ctypes.windll.kernel32.GetVolumeInformationW(
                        ctypes.c_wchar_p(letter + ":\\"), vol, 261, ctypes.byref(serial),
                        None, None, fs, 261)
                    if ok:
                        serials.append("%s-%08X" % (letter, serial.value))
            except Exception:
                pass
    elif platform.system() == "Linux":
        out = _run(["lsblk", "--nodeps", "-no", "serial"])
        serials = [l.strip() for l in out.splitlines() if l.strip()]
        if not serials:
            base = "/dev/disk/by-id"
            if os.path.isdir(base):
                serials = [f for f in os.listdir(base) if not f.startswith("nvme-eui") and "part" not in f]
    elif platform.system() == "Darwin":
        out = _run(["ioreg", "-rd1", "-c", "IOPlatformExpertDevice"])
        for line in out.splitlines():
            if "IOPlatformSerialNumber" in line and "=" in line:
                serials.append(line.split("=")[-1].strip().strip('"'))
    serials = [s for s in serials if s]
    _CACHE["disk"] = serials
    return serials


def get_machine_id():
    if "mid" in _CACHE:
        return _CACHE["mid"]
    mid = ""
    if platform.system() == "Windows":
        try:
            import winreg
            for hive, view in ((winreg.HKEY_LOCAL_MACHINE, winreg.KEY_WOW64_64KEY),
                               (winreg.HKEY_LOCAL_MACHINE, 0)):
                try:
                    with winreg.OpenKey(hive, r"SOFTWARE\Microsoft\Cryptography", 0,
                                        winreg.KEY_READ | view) as k:
                        mid, _ = winreg.QueryValueEx(k, "MachineGuid")
                        break
                except OSError:
                    continue
        except Exception:
            pass
    elif platform.system() == "Linux":
        for p in ("/etc/machine-id", "/var/lib/dbus/machine-id"):
            try:
                with open(p) as f:
                    mid = f.read().strip()
                if mid:
                    break
            except OSError:
                continue
    elif platform.system() == "Darwin":
        out = _run(["ioreg", "-rd1", "-c", "IOPlatformExpertDevice"])
        for line in out.splitlines():
            if "IOPlatformUUID" in line and "=" in line:
                mid = line.split("=")[-1].strip().strip('"')
    if not mid:
        mid = platform.node() or ""
    _CACHE["mid"] = mid
    return mid


def get_hostnames():
    names = []
    try:
        names.append(socket.gethostname())
    except Exception:
        pass
    try:
        fqdn = socket.getfqdn()
        if fqdn and fqdn not in names:
            names.append(fqdn)
    except Exception:
        pass
    return [n for n in names if n]


def all_fingerprints():
    """Return dict of fingerprint category -> list of string values."""
    vals = {
        "mac": [get_mac()] if get_mac() else [],
        "ipv4": [get_ipv4()] if get_ipv4() else [],
        "disk": get_disk_serials(),
        "machine_id": [get_machine_id()] if get_machine_id() else [],
        "host": get_hostnames(),
    }
    return {k: v for k, v in vals.items() if v}


def all_values():
    out = []
    for vals in all_fingerprints().values():
        out.extend(vals)
    return out


def fingerprint_hashes():
    return {hashlib.sha256(v.encode("utf-8", "replace")).hexdigest() for v in all_values()}


if __name__ == "__main__":
    for cat, vals in all_fingerprints().items():
        for v in vals:
            print("%-12s %s" % (cat, v))
