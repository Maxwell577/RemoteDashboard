"""SentraRMM Python agent package (v0.3.0 protocol).

A TRANSPARENT remote-management agent for Windows (cross-platform capable).
Every user-facing visibility feature lives in :mod:`sentra_agent.transparency`
and is intentionally NON-OPTIONAL: no configuration switch can disable the
startup banner, the remote-action toasts, the tray icon or the recording
overlay.
"""

__version__ = "0.3.0"

PROTOCOL_VERSION = "v0.3"
AGENT_FLAVOR = "python"
