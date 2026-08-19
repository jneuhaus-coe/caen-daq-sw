from __future__ import annotations

import argparse

import uvicorn

from .acquisition import AcquisitionEngine
from .server import create_app


def main():
    p = argparse.ArgumentParser(description="DT5742B DAQ server")
    p.add_argument("--backend", default="sim", choices=["sim", "caen"],
                   help="digitizer backend (default: sim)")
    p.add_argument("--host", default="127.0.0.1")
    p.add_argument("--port", type=int, default=8000)
    p.add_argument("--sim-rate", type=float, default=200.0,
                   help="simulator trigger rate (Hz)")
    p.add_argument("--no-open", action="store_true",
                   help="do not open the board at startup (open on first start)")
    args = p.parse_args()

    engine = AcquisitionEngine(backend_kind=args.backend, sim_rate_hz=args.sim_rate)
    if not args.no_open:
        try:
            info = engine.open()
            print(f"[daq] opened backend={args.backend}: {info.model} "
                  f"(sw={info.sw_release})")
        except Exception as e:
            print(f"[daq] WARNING: could not open board at startup: {e}")
            print("[daq] will retry on first Start.")

    app = create_app(engine)
    print(f"[daq] UI at http://{args.host}:{args.port}/")
    uvicorn.run(app, host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
