"""Acquisition engine: owns the backend, runs readout on its own thread fully
decoupled from the web server, and exposes cheap telemetry snapshots (decimated
averaged waveforms for all enabled channels + a rolling trigger-rate window)."""
from __future__ import annotations

import threading
import time

import numpy as np

from .backend.base import make_backend, DigitizerBackend, BoardInfo
from .config import BoardConfig
from .stats import RollingAverage, TriggerRateMeter, decimate
from .writer import make_writer
from . import constants as C


class AcquisitionEngine:
    def __init__(self, backend_kind: str = "sim", sim_rate_hz: float = 200.0):
        self._backend_kind = backend_kind
        self._backend: DigitizerBackend | None = None
        self._board_info = BoardInfo()
        self._cfg = BoardConfig.load_last_or_default()
        self._avg = RollingAverage()
        self._rate = TriggerRateMeter()
        self._writer = None

        self._thread: threading.Thread | None = None
        self._running = threading.Event()
        self._lock = threading.Lock()
        self._sim_rate_hz = sim_rate_hz
        self._events_seen = 0
        self._errors: list[str] = []
        self._opened = False

    # ---------- lifecycle ----------
    def open(self):
        self._backend = (make_backend(self._backend_kind, rate_hz=self._sim_rate_hz)
                         if self._backend_kind == "sim"
                         else make_backend(self._backend_kind))
        self._board_info = self._backend.open()
        self._opened = True
        return self._board_info

    def get_config(self) -> BoardConfig:
        with self._lock:
            return self._cfg

    def set_config(self, cfg: BoardConfig):
        with self._lock:
            self._cfg = cfg
            cfg.persist()
        if self._running.is_set():
            self._backend.configure(cfg)

    def start(self):
        if self._running.is_set():
            return
        if not self._opened:
            self.open()
        with self._lock:
            cfg = self._cfg
        self._backend.configure(cfg)
        self._writer = make_writer(cfg)
        self._writer.open(cfg)
        self._backend.start()
        self._running.set()
        self._thread = threading.Thread(target=self._loop, name="acq", daemon=True)
        self._thread.start()

    def stop(self):
        if not self._running.is_set():
            return
        self._running.clear()
        if self._thread:
            self._thread.join(timeout=2.0)
        try:
            self._backend.stop()
        except Exception as e:
            self._record_error(f"stop: {e}")
        if self._writer:
            self._writer.close()
            self._writer = None

    def close(self):
        self.stop()
        if self._backend and self._opened:
            self._backend.close()
            self._opened = False

    # ---------- readout loop ----------
    def _loop(self):
        while self._running.is_set():
            try:
                events = self._backend.read_events()
            except Exception as e:
                self._record_error(f"read: {e}")
                time.sleep(0.05)
                continue
            if not events:
                time.sleep(0.002)
                continue
            t = time.monotonic()
            for ev in events:
                self._events_seen += 1
                for ch, wave in ev.samples.items():
                    self._avg.add(ch, wave, t)
                if self._writer:
                    self._writer.write(ev)
            self._rate.add(len(events))

    def _record_error(self, msg: str):
        with self._lock:
            self._errors.append(f"{time.strftime('%H:%M:%S')} {msg}")
            self._errors = self._errors[-50:]

    # ---------- telemetry ----------
    def telemetry(self, _channels=None) -> dict:
        with self._lock:
            cfg = self._cfg
        chans = cfg.enabled_channels()
        dt = C.sample_period_ns(cfg.drs4_frequency)
        channels = {}
        for ch in chans:
            mean, count = self._avg.snapshot(ch)
            if mean is None:
                channels[str(ch)] = {"count": 0}
                continue
            vpp = float(mean.max() - mean.min())
            channels[str(ch)] = {
                "wave": decimate(mean, C.OVERVIEW_POINTS),
                "count": count,
                "vpp": vpp,
                "min": float(mean.min()),
                "max": float(mean.max()),
                "baseline": float(np.median(mean)),
            }
        return {
            "running": self._running.is_set(),
            "sample_period_ns": dt,
            "record_length": cfg.record_length,
            "overview_points": C.OVERVIEW_POINTS,
            "avg_window_s": self._avg.window_s,
            "events_seen": self._events_seen,
            "enabled_channels": chans,
            "channels": channels,
            "rate": self._rate.snapshot(),
        }

    def status(self) -> dict:
        bi = self._board_info
        return {
            "opened": self._opened,
            "running": self._running.is_set(),
            "backend": self._backend_kind,
            "board": {
                "model": bi.model, "family": bi.family_code, "serial": bi.serial,
                "roc_firmware": bi.roc_firmware, "amc_firmware": bi.amc_firmware,
                "sw_release": bi.sw_release,
            },
            "events_seen": self._events_seen,
            "errors": list(self._errors),
        }
