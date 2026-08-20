"""Acquisition engine: owns the backend, runs readout on its own thread fully
decoupled from the web server, and exposes cheap telemetry snapshots (decimated
averaged waveforms for all enabled channels + a rolling trigger-rate window)."""
from __future__ import annotations

import threading
import time

import numpy as np

from .backend.base import make_backend, DigitizerBackend, BoardInfo
from .config import BoardConfig, default_config
from .stats import RollingAverage, TriggerRateMeter, decimate
from .writer import make_writer
from . import runs
from . import constants as C


class AcquisitionEngine:
    def __init__(self):
        self._backend: DigitizerBackend | None = None
        self._board_info = BoardInfo()
        self._cfg = default_config()   # only a seed; the board wins once open
        self._avg = RollingAverage()
        self._rate = TriggerRateMeter()
        # Recording is independent of acquiring: you watch first, then record.
        self._writer = None
        self._run_id: str | None = None
        self._run_started: float | None = None
        self._recorded = 0

        self._thread: threading.Thread | None = None
        self._running = threading.Event()
        self._lock = threading.Lock()
        self._events_seen = 0
        self._errors: list[str] = []
        self._opened = False
        self._last_open_attempt = 0.0

    # ---------- lifecycle ----------
    def open(self):
        self._backend = make_backend()
        self._board_info = self._backend.open()
        self._opened = True
        # The board, not our last-used file, is the source of truth.
        cfg, errs = self._backend.read_settings(self._cfg)
        with self._lock:
            self._cfg = cfg
        for e in errs:
            self._record_error(f"read settings: {e}")
        return self._board_info

    def get_config(self) -> BoardConfig:
        with self._lock:
            return self._cfg

    def set_config(self, cfg: BoardConfig) -> BoardConfig:
        """Push to the board and adopt what it reports back. Returns the actual
        config; anything the board refused lands in the error list."""
        if not self._opened or self._backend is None:
            # Nothing was sent anywhere. Returning the requested config here
            # would have the UI show - and confirm - a value the unit never
            # received, and it would be discarded anyway the moment we reopen
            # and read the unit's own settings.
            self._record_error("no unit connected: settings were not applied")
            with self._lock:
                return self._cfg

        errors: list[str] = []
        try:
            cfg, errors = self._backend.write_settings(cfg)
        except Exception as e:
            errors = [f"write settings: {e}"]
        with self._lock:
            self._cfg = cfg
        for e in errors:
            self._record_error(e)
        return cfg

    def start(self):
        if self._running.is_set():
            return
        if not self._opened:
            self.open()
        with self._lock:
            cfg = self._cfg
        actual, cfg_errs = self._backend.configure(cfg)
        with self._lock:
            self._cfg = actual
        for e in cfg_errs:
            self._record_error(e)
        self._events_seen = 0      # Count reflects this acquisition run
        self._rate.reset()
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
        self.stop_recording()
        try:
            self._backend.stop()
        except Exception as e:
            self._record_error(f"stop: {e}")

    def close(self):
        self.stop()
        if self._backend and self._opened:
            self._backend.close()
            self._opened = False

    # ---------- connection health ----------
    def probe(self) -> bool:
        """Liveness for the UI, safe to call on every status poll.

        While acquiring, the readout loop is the authority — a concurrent board
        call would race it. While idle, poke the board, and retry a lost one at
        a slow cadence so the app recovers once the unit is switched back on.
        """
        if self._running.is_set():
            return self._opened
        if self._opened and self._backend is not None:
            alive = False
            try:
                alive = bool(self._backend.is_alive())
            except Exception:
                alive = False
            if alive:
                return True
            self._opened = False
            self._board_info = BoardInfo()
            self._record_error("board stopped responding")
        self._try_open(force=False)
        return self._opened

    def reconnect(self) -> dict:
        """Explicit user-driven reconnect: drop what we have and open again now."""
        self.stop()
        self._opened = False
        self._try_open(force=True)
        return self.status()

    def _try_open(self, force: bool):
        if self._opened:
            return
        now = time.monotonic()
        if not force and now - self._last_open_attempt < C.RECONNECT_RETRY_S:
            return
        self._last_open_attempt = now
        if self._backend is not None:
            try:
                self._backend.close()
            except Exception:
                pass
            self._backend = None
        try:
            self.open()
        except Exception as e:
            # Silent while auto-retrying; the badge already reads disconnected.
            if force:
                self._record_error(f"reconnect: {e}")

    # ---------- recording ----------
    def start_recording(self, name: str, timestamp: bool = True) -> dict:
        """Begin writing to a new run directory, starting acquisition if the
        operator has not already. Watching and recording are separate actions."""
        if self._writer is not None:
            return {"ok": False, "error": "already recording"}
        if not self._opened:
            return {"ok": False, "error": "no unit connected"}
        if not self._running.is_set():
            self.start()
        try:
            run_id, path = runs.create(name, timestamp)
        except FileExistsError as e:
            return {"ok": False,
                    "error": f"a run named {e.args[0]!r} already exists - "
                             f"rename it or switch the timestamp on"}
        with self._lock:
            cfg = self._cfg
        writer = make_writer(path, run_id)      # the directory name is the name
        try:
            writer.open(cfg)
        except Exception as e:
            self._record_error(f"record: {e}")
            return {"ok": False, "error": str(e)}
        self._recorded = 0
        self._run_started = time.time()
        self._run_id = run_id
        self._writer = writer          # last: the loop starts writing here
        return {"ok": True, "run": run_id}

    def stop_recording(self) -> dict:
        w, run_id = self._writer, self._run_id
        self._writer = None            # first: the loop stops writing
        if w is None:
            return {"ok": False, "error": "not recording"}
        try:
            w.close()
        except Exception as e:
            self._record_error(f"record close: {e}")
        self._run_id = None
        self._run_started = None
        return {"ok": True, "run": run_id}

    # ---------- readout loop ----------
    def _loop(self):
        fails = 0
        while self._running.is_set():
            try:
                events = self._backend.read_events()
                fails = 0
            except Exception as e:
                fails += 1
                self._record_error(f"read: {e}")
                if fails >= C.READ_FAIL_LIMIT:
                    self._record_error("board stopped responding - acquisition halted")
                    self._opened = False
                    self._board_info = BoardInfo()
                    self._running.clear()
                    break
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
                    self._recorded += 1
            self._rate.add(len(events))
        if not self._opened and self._writer:   # bailed out on a lost board
            try:
                self._writer.close()
            except Exception:
                pass
            self._writer = None

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
            "recording": self._writer is not None,
            "run_id": self._run_id,
            "run_started": self._run_started,
            "recorded": self._recorded,
            "enabled_channels": chans,
            "channels": channels,
            "rate": self._rate.snapshot(),
        }

    def status(self) -> dict:
        bi = self._board_info
        return {
            "opened": self._opened,
            "running": self._running.is_set(),
            "backend": "caen",
            "board": {
                "model": bi.model, "family": bi.family_code, "serial": bi.serial,
                "roc_firmware": bi.roc_firmware, "amc_firmware": bi.amc_firmware,
                "sw_release": bi.sw_release,
            },
            "events_seen": self._events_seen,
            "recording": self._writer is not None,
            "run_id": self._run_id,
            "run_started": self._run_started,
            "recorded": self._recorded,
            "data_dir": runs.DATA_ROOT,
            "errors": list(self._errors),
        }
