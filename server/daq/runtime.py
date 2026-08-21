"""Where the running server records itself, so `daq` can find and attach to it.

The file is a hint, never an authority: it can outlive a crashed server, name a
port something else has since taken, or be left behind by a different user. Every
read is therefore confirmed by asking the server itself who it is.
"""
from __future__ import annotations

import json
import os
import socket
import sys
import time
from typing import Optional

from . import __version__

APP_ID = "dt5742b-daq"
_PROBE_TIMEOUT = 2.0


def state_dir() -> str:
    """Per-user state directory, following each platform's own convention."""
    if os.name == "nt":
        base = os.environ.get("LOCALAPPDATA") or os.path.expanduser("~")
    else:
        base = os.environ.get("XDG_STATE_HOME") or os.path.expanduser("~/.local/state")
    return os.path.join(base, APP_ID)


def runtime_path() -> str:
    return os.path.join(state_dir(), "runtime.json")


def url_for(host: str, port: int) -> str:
    """The URL to point a *local* browser at.

    A server bound to 0.0.0.0 is reachable on every interface, but the address to
    open here is always the loopback one.
    """
    shown = "127.0.0.1" if host in ("0.0.0.0", "::", "") else host
    return f"http://{shown}:{port}/"


def write(host: str, port: int) -> None:
    os.makedirs(state_dir(), exist_ok=True)
    record = {
        "app": APP_ID,
        "version": __version__,
        "pid": os.getpid(),
        "host": host,
        "port": port,
        "url": url_for(host, port),
        "started": time.time(),
        "executable": sys.executable,
    }
    tmp = runtime_path() + ".tmp"
    with open(tmp, "w") as f:
        json.dump(record, f, indent=2)
    os.replace(tmp, runtime_path())          # never leave a half-written file


def clear() -> None:
    try:
        os.remove(runtime_path())
    except OSError:
        pass


def read() -> Optional[dict]:
    try:
        with open(runtime_path()) as f:
            record = json.load(f)
    except (OSError, ValueError):
        return None
    return record if isinstance(record, dict) and record.get("port") else None


def probe(port: int, host: str = "127.0.0.1", timeout: float = _PROBE_TIMEOUT) -> Optional[dict]:
    """Ask whoever is on that port whether they are one of ours.

    Returns the status payload, or None if nothing answers or the answer is from
    some other program that merely happens to hold the port.
    """
    import urllib.error
    import urllib.request

    url = f"http://{host}:{port}/api/status"
    try:
        with urllib.request.urlopen(url, timeout=timeout) as r:
            payload = json.loads(r.read().decode("utf-8"))
    except (urllib.error.URLError, OSError, ValueError, TimeoutError):
        return None
    return payload if isinstance(payload, dict) and payload.get("app") == APP_ID else None


def find_server() -> Optional[dict]:
    """The live server, or None. Clears the runtime file when it is stale.

    Returns a dict with `url`, `port`, `version` and the server's `status`.
    """
    record = read()
    if not record:
        return None
    status = probe(int(record["port"]))
    if status is None:
        clear()
        return None
    return {
        "url": record.get("url") or url_for(record.get("host", "127.0.0.1"), record["port"]),
        "port": int(record["port"]),
        "pid": record.get("pid"),
        "version": status.get("version") or record.get("version"),
        "status": status,
    }


def port_is_free(host: str, port: int) -> bool:
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        s.bind((host, port))
        return True
    except OSError:
        return False
    finally:
        s.close()
