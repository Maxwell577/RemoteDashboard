"""File operations (fs:list/download/upload/delete/rename/mkdir).

Same wire shapes as the Node reference agent (agent/index.mjs):
  FsListing { path, parent, drives, entries[{name, path, type, sizeBytes,
              modifiedAt, hidden, ext}] }
  fs:download → { path, name, sizeBytes, contentBase64, encryptedNote }
  fs:upload   → { ok, path, name }
  fs:delete   → { ok, removed }
  fs:rename   → { ok, path }
  fs:mkdir    → { ok, path }

Everything is scoped to a root (default: the user home, like agent/index.mjs),
traversal-guarded, 500 entries / 20MB inline-transfer caps.
"""
from __future__ import annotations

import os
import sys
import time
from typing import Any, Dict, List

MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024
MAX_ENTRIES = 500

IS_WIN = sys.platform.startswith("win")


def _iso(ts: float) -> str:
    try:
        return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime(ts)) + "Z"
    except (ValueError, OverflowError):
        return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(0))


class FileScope:
    """Root-scoped filesystem helpers mirroring the Node agent's FileScope."""

    def __init__(self, root: str) -> None:
        self.root = os.path.abspath(os.path.expanduser(root))
        try:
            os.makedirs(self.root, exist_ok=True)
        except OSError:
            pass

    # -- path safety ---------------------------------------------------------

    def resolve_in(self, rel: Any) -> str:
        """Resolve a request path inside the root; raise when it escapes."""
        raw = str(rel or ".")
        # a leading "~" means "the scope root" (the dashboard / API use it as
        # the home shortcut, matching agent ops that pass path=~)
        if raw == "~" or raw.startswith("~/") or raw.startswith("~\\"):
            raw = raw[1:]
        # strip windows drive / absolute prefixes so paths stay under root
        cleaned = raw.replace("\\", "/")
        while cleaned.startswith("/"):
            cleaned = cleaned[1:]
        if len(cleaned) >= 2 and cleaned[1] == ":":
            cleaned = cleaned[2:].lstrip("/")
        cleaned = cleaned or "."
        abs_path = os.path.abspath(os.path.join(self.root, cleaned))
        real_root = os.path.abspath(self.root)
        if abs_path != real_root and not abs_path.startswith(real_root + os.sep):
            raise ValueError("Path escapes the agent file scope")
        return abs_path

    @staticmethod
    def _rel(root: str, p: str) -> str:
        r = os.path.relpath(p, root)
        return "." if r == "." else r.replace(os.sep, "/")

    # -- operations ----------------------------------------------------------

    def list(self, rel_path: Any) -> Dict[str, Any]:
        abs_path = self.resolve_in(rel_path or ".")
        if not os.path.isdir(abs_path):
            raise NotADirectoryError(f"Not a directory: {self._rel(self.root, abs_path)}")
        entries: List[Dict[str, Any]] = []
        with os.scandir(abs_path) as it:
            for d in it:
                if len(entries) >= MAX_ENTRIES:
                    break
                try:
                    st = d.stat(follow_symlinks=False)
                    is_dir = d.is_dir(follow_symlinks=False)
                    entries.append({
                        "name": d.name,
                        "path": self._rel(self.root, d.path),
                        "type": "directory" if is_dir else "file",
                        "sizeBytes": 0 if is_dir else int(st.st_size),
                        "modifiedAt": _iso(st.st_mtime),
                        "hidden": d.name.startswith("."),
                        "ext": ("" if is_dir else os.path.splitext(d.name)[1].lstrip(".")) or None,
                    })
                except OSError:
                    # stat raced a delete — still list the name with defaults
                    entries.append({
                        "name": d.name, "path": self._rel(self.root, d.path),
                        "type": "file", "sizeBytes": 0,
                        "modifiedAt": _iso(time.time()),
                        "hidden": d.name.startswith("."), "ext": None,
                    })
        entries.sort(key=lambda e: (0 if e["type"] == "directory" else 1, str(e["name"]).lower()))
        rel = self._rel(self.root, abs_path)
        parent: Any = None
        if rel != ".":
            parent = os.path.dirname(rel).replace(os.sep, "/") or "."
        from .captures import windows_drives
        drives = windows_drives()
        return {"path": rel, "parent": parent, "drives": drives, "entries": entries}

    def download(self, rel_path: Any) -> Dict[str, Any]:
        import base64

        abs_path = self.resolve_in(rel_path)
        st = os.stat(abs_path)
        if not os.path.isfile(abs_path):
            raise ValueError("Not a file")
        if st.st_size > MAX_DOWNLOAD_BYTES:
            raise ValueError(
                f"File too large for inline transfer (>{MAX_DOWNLOAD_BYTES // (1024 * 1024)}MB)"
            )
        with open(abs_path, "rb") as fh:
            data = fh.read()
        return {
            "path": str(rel_path),
            "name": os.path.basename(abs_path),
            "sizeBytes": int(st.st_size),
            "contentBase64": base64.b64encode(data).decode("ascii"),
            "encryptedNote": "transferred over the hub's socket; stored encrypted at rest by the console",
        }

    def upload(self, rel_dir: Any, name: Any, content_b64: Any) -> Dict[str, Any]:
        import base64

        abs_dir = self.resolve_in(rel_dir or ".")
        safe_name = os.path.basename(str(name or "upload.bin")) or "upload.bin"
        target = os.path.join(abs_dir, safe_name)
        if not target.startswith(os.path.abspath(self.root) + os.sep) and os.path.abspath(target) != os.path.abspath(self.root):
            raise ValueError("Path escapes the agent file scope")
        data = base64.b64decode(str(content_b64 or ""), validate=False)
        with open(target, "wb") as fh:
            fh.write(data)
        return {"ok": True, "path": self._rel(self.root, target), "name": os.path.basename(target)}

    def delete(self, rel_path: Any) -> Dict[str, Any]:
        import shutil as _shutil

        abs_path = self.resolve_in(rel_path)
        if os.path.abspath(abs_path) == os.path.abspath(self.root):
            raise ValueError("Refusing to delete the file-scope root")
        if os.path.isdir(abs_path) and not os.path.islink(abs_path):
            _shutil.rmtree(abs_path)
            removed = os.path.basename(abs_path) + "/"
        else:
            os.remove(abs_path)
            removed = os.path.basename(abs_path)
        return {"ok": True, "removed": removed}

    def rename(self, rel_path: Any, new_name: Any) -> Dict[str, Any]:
        abs_path = self.resolve_in(rel_path)
        safe = os.path.basename(str(new_name or "")).strip()
        if not safe:
            raise ValueError("newName is required")
        target = os.path.join(os.path.dirname(abs_path), safe)
        if not target.startswith(os.path.abspath(self.root) + os.sep):
            raise ValueError("Path escapes the agent file scope")
        os.rename(abs_path, target)
        return {"ok": True, "path": self._rel(self.root, target)}

    def mkdir(self, rel_path: Any) -> Dict[str, Any]:
        abs_path = self.resolve_in(rel_path)
        os.makedirs(abs_path, exist_ok=True)
        return {"ok": True, "path": self._rel(self.root, abs_path) or "."}
