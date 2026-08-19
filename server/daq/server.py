"""FastAPI app: REST control plane + WebSocket telemetry, plus static frontend.
Telemetry pushes server-side aggregates (decimated averaged waveforms for all
enabled channels + a rolling rate window) at a fixed cadence."""
from __future__ import annotations

import asyncio
import os

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles

from .acquisition import AcquisitionEngine
from .config import BoardConfig, default_config
from .catalog import catalog
from . import constants as C

STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")


def create_app(engine: AcquisitionEngine) -> FastAPI:
    app = FastAPI(title="DT5742B DAQ")

    @app.get("/api/status")
    def status():
        engine.probe()          # keeps `opened` honest between polls
        return engine.status()

    @app.post("/api/board/reconnect")
    def reconnect():
        return engine.reconnect()

    @app.get("/api/catalog")
    def get_catalog():
        return catalog()

    @app.get("/api/config")
    def get_config():
        return engine.get_config().to_dict()

    @app.post("/api/config")
    def set_config(payload: dict):
        cfg = BoardConfig.from_dict(payload)
        engine.set_config(cfg)
        return {"ok": True, "config": cfg.to_dict()}

    @app.post("/api/config/default")
    def reset_default():
        cfg = default_config()
        engine.set_config(cfg)
        return cfg.to_dict()

    @app.post("/api/config/apply")
    def apply_fanout(payload: dict):
        """Fan a channel's DC offset onto a bank or all channels."""
        src = int(payload["source"])
        scope = payload.get("scope", "all")  # 'all' | 'bank' | explicit list
        cfg = engine.get_config()
        if scope == "all":
            targets = list(range(C.NUM_CHANNELS))
        elif scope == "bank":
            targets = cfg.bank_channels(C.channel_group(src))
        else:
            targets = [int(t) for t in payload.get("targets", [])]
        cfg.apply_channel_dc_to(src, targets)
        engine.set_config(cfg)
        return cfg.to_dict()

    @app.post("/api/acq/start")
    def start():
        engine.start()
        return engine.status()

    @app.post("/api/acq/stop")
    def stop():
        engine.stop()
        return engine.status()

    @app.websocket("/ws/telemetry")
    async def telemetry(ws: WebSocket):
        await ws.accept()
        try:
            while True:
                await ws.send_json(engine.telemetry())
                await asyncio.sleep(1.0 / C.TELEMETRY_HZ)
        except (WebSocketDisconnect, RuntimeError):
            return
        except Exception:
            return

    if os.path.isdir(STATIC_DIR):
        app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")

    return app
