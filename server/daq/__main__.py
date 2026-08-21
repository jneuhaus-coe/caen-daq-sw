from __future__ import annotations

import argparse
import errno
import os
import socket
import sys

import uvicorn

from . import __version__
from .acquisition import AcquisitionEngine
from .server import create_app


def _err(msg: str) -> None:
    print(f"[daq] {msg}", file=sys.stderr)


def _check_bindable(host: str, port: int) -> None:
    """Explain a bind failure instead of leaving uvicorn's bare OSError.

    Windows answers EACCES — not EADDRINUSE — when a port falls inside a range
    reserved by Hyper-V or WSL, and that needs a different fix from a port that
    is merely taken, so the two are worth telling apart.
    """
    probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        probe.bind((host, port))
    except OSError as e:
        if e.errno == errno.EADDRINUSE:
            _err(f"port {port} is already in use — another daq is probably running.")
            _err("stop that one, or start this one on another port: daq --port 8800")
        elif e.errno in (errno.EACCES, errno.EPERM):
            _err(f"not allowed to bind {host}:{port}.")
            if os.name == "nt":
                _err("on Windows this usually means the port sits inside a range reserved")
                _err("by Hyper-V or WSL. List the reserved ranges with:")
                _err("    netsh interface ipv4 show excludedportrange protocol=tcp")
                _err("then pick a port outside them: daq --port 8800")
            elif port < 1024:
                _err("ports below 1024 need root. Use --port 8000 or higher.")
        else:
            _err(f"cannot bind {host}:{port}: {e}")
        raise SystemExit(2)
    finally:
        probe.close()


def main():
    p = argparse.ArgumentParser(description="DT5742B DAQ server")
    p.add_argument("--version", action="version", version=f"dt5742b-daq {__version__}")
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=8000)
    p.add_argument("--no-open", action="store_true",
                   help="do not open the board at startup (open on first start)")
    args = p.parse_args()

    _check_bindable(args.host, args.port)

    engine = AcquisitionEngine()
    if not args.no_open:
        try:
            info = engine.open()
            print(f"[daq] opened: {info.model} (sw={info.sw_release})")
        except Exception as e:
            print(f"[daq] WARNING: could not open board at startup: {e}")
            print("[daq] will retry on first Start.")

    app = create_app(engine)
    print(f"[daq] dt5742b-daq {__version__} — UI at http://{args.host}:{args.port}/")
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
