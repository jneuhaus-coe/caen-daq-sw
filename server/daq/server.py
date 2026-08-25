"""FastAPI app: REST control plane + WebSocket telemetry, plus static frontend.
Telemetry pushes server-side aggregates (decimated averaged waveforms for all
enabled channels + a rolling rate window) at a fixed cadence."""
from __future__ import annotations

import asyncio
import os

from fastapi import (BackgroundTasks, FastAPI, HTTPException, Request, Response,
                     WebSocket, WebSocketDisconnect)
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from . import __version__
import logging

from . import logsetup

log = logsetup.get("daq.api")
from .acquisition import AcquisitionEngine
from .config import BoardConfig, default_config
from .catalog import catalog
from . import configfile
from . import runs
from . import constants as C

STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")


def create_app(engine: AcquisitionEngine) -> FastAPI:
    app = FastAPI(title="DT5742B DAQ")

    @app.get("/api/status")
    def status():
        engine.probe()          # keeps `opened` honest between polls
        # `app` identifies us to the launcher, which must not mistake some other
        # program holding the port for a DAQ server it can attach to.
        return {**engine.status(), "app": "dt5742b-daq", "version": __version__,
                "log_file": logsetup.active_log_path()}

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
        before = len(engine.status()["errors"])
        cfg = engine.set_config(BoardConfig.from_dict(payload))
        st = engine.status()
        new = st["errors"][before:]
        return {"ok": not new, "config": cfg.to_dict(), "errors": new,
                "connected": st["opened"]}

    @app.get("/api/config/file")
    def save_config_file(names: bool = True):
        body = configfile.to_json(engine.get_config(), include_names=names)
        return Response(
            body, media_type="application/json",
            headers={"Content-Disposition": 'attachment; filename="daq-config.json"'})

    @app.post("/api/config/file")
    async def load_config_file(request: Request):
        """Accepts our JSON or a CAEN WaveDumpConfig.txt."""
        text = (await request.body()).decode("utf-8", errors="replace")
        with logsetup.step(log, "Loading a settings file") as loading:
            try:
                loaded, notes = configfile.from_text(text)
            except Exception as e:
                loading.done(f"Could not parse the file: {e}")
                return {"ok": False, "errors": [f"could not parse: {e}"], "notes": [],
                        "config": engine.get_config().to_dict(), "restart": []}
            loading.done(f"Read with {len(notes)} notes" if notes else "Read")
        restart = configfile.needs_restart(engine.get_config(), loaded)
        before = len(engine.status()["errors"])
        cfg = engine.set_config(loaded)
        new = engine.status()["errors"][before:]
        return {"ok": not new, "config": cfg.to_dict(), "errors": new,
                "notes": notes, "restart": restart,
                "running": engine.status()["running"]}

    @app.post("/api/config/default")
    def reset_default():
        return engine.set_config(default_config()).to_dict()

    @app.post("/api/rec/start")
    def rec_start(payload: dict | None = None):
        p = payload or {}
        r = engine.start_recording((p.get("name") or "").strip(),
                                   bool(p.get("timestamp", True)))
        return {**r, "status": engine.status()}

    @app.post("/api/rec/stop")
    def rec_stop():
        r = engine.stop_recording()
        return {**r, "status": engine.status()}

    @app.get("/api/runs")
    def list_runs():
        return {"data_dir": runs.DATA_ROOT, "runs": runs.listing()}

    @app.get("/api/runs/{run_id}/download")
    def download_run(run_id: str, background: BackgroundTasks):
        if engine.status()["run_id"] == run_id:
            raise HTTPException(409, "that run is still recording")
        tmp = runs.zip_to_temp(run_id)
        if tmp is None:
            raise HTTPException(404, "no such run")
        background.add_task(os.unlink, tmp)      # cleaned up after the response
        return FileResponse(tmp, media_type="application/zip",
                            filename=f"{run_id}.zip", background=background)

    @app.delete("/api/runs/{run_id}")
    def delete_run(run_id: str):
        if engine.status()["run_id"] == run_id:
            logsetup.did(log, f"Deleting run {run_id!r}", "Refused: still recording",
                         level=logging.WARNING)
            raise HTTPException(409, "that run is still recording")
        if not runs.delete(run_id):
            logsetup.did(log, f"Deleting run {run_id!r}", "No such run",
                         level=logging.WARNING)
            raise HTTPException(404, "no such run")
        logsetup.did(log, f"Deleting run {run_id!r}", "Ok")
        return {"ok": True, "deleted": run_id}

    @app.post("/api/acq/start")
    def start():
        engine.start()
        return engine.status()

    @app.post("/api/trigger")
    def trigger(payload: dict | None = None):
        """Queue software triggers - the bench check when nothing external
        can trigger the board. {"count": 100, "rate_hz": 10} both optional."""
        p = payload or {}
        r = engine.fire_software_triggers(int(p.get("count", 1)),
                                          float(p.get("rate_hz", 10.0)))
        return {**r, "status": engine.status()}

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
