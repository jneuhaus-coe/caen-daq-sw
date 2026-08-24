"""Acquisition engine: owns the backend, runs readout on its own thread fully
decoupled from the web server, and exposes cheap telemetry snapshots (decimated
averaged waveforms for all enabled channels + a rolling trigger-rate window)."""
from __future__ import annotations

import logging
import threading
import time

import numpy as np

from .backend.base import make_backend, DigitizerBackend, BoardInfo
from .config import BoardConfig, default_config
from .stats import RollingAverage, TriggerRateMeter, decimate
from .writer import make_writer
from . import runs
from . import constants as C
from . import logsetup


log = logsetup.get("daq.acq")


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
        # Serialises opening the board. Startup now opens on a worker thread, so
        # a status poll arriving mid-open would otherwise call _try_open and put
        # a second thread inside libCAENDigitizer on the same handle.
        self._open_lock = threading.RLock()
        self._events_seen = 0
        self._errors: list[str] = []
        self._opened = False
        self._last_open_attempt = 0.0

    # ---------- lifecycle ----------
    def open(self, level: int = logging.INFO):
        with self._open_lock:
            with logsetup.step(log, "opening the digitizer", level=level) as opening:
                backend = make_backend()
                board_info = backend.open()
                self._backend = backend
                self._board_info = board_info
                opening.note(f"{board_info.model} S/N {board_info.serial}, "
                             f"ROC {board_info.roc_firmware}, AMC {board_info.amc_firmware}")

            # The board, not our last-used file, is the source of truth.
            with logsetup.step(log, "reading settings back off the unit",
                               level=level) as reading:
                cfg, errs = backend.read_settings(self._cfg)
                reading.note(f"{len(errs)} could not be read" if errs else "all readable")
            with self._lock:
                self._cfg = cfg
            for e in errs:
                log.warning("  setting not readable: %s", e)
                self._record_error(f"read settings: {e}")
            # Last, not first: while this is False every other path treats the
            # unit as absent and keeps off the wire, so nothing talks to a board
            # that is still being set up.
            self._opened = True
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
            log.warning("settings not applied: no unit connected")
            self._record_error("no unit connected: settings were not applied")
            with self._lock:
                return self._cfg

        errors: list[str] = []
        with logsetup.step(log, "writing settings to the unit") as writing:
            try:
                cfg, errors = self._backend.write_settings(cfg)
            except Exception as e:
                errors = [f"write settings: {e}"]
            writing.note(f"{len(errors)} refused or mismatched" if errors
                         else "all accepted and read back")
        with self._lock:
            self._cfg = cfg
        for e in errors:
            log.warning("  %s", e)
            self._record_error(e)
        return cfg

    def start(self):
        if self._running.is_set():
            return
        with logsetup.step(log, "starting acquisition") as starting:
            if not self._opened:
                try:
                    self.open()
                except Exception as e:
                    # Refuse rather than raise: with no unit there is nothing to
                    # acquire, and a traceback through the API tells the
                    # operator nothing the badge does not already say.
                    starting.result("no unit connected")
                    self._record_error(f"start: {e}")
                    return
            with self._lock:
                cfg = self._cfg
            with logsetup.step(log, "applying settings to the unit") as applying:
                actual, cfg_errs = self._backend.configure(cfg)
                applying.note(f"{len(cfg_errs)} refused" if cfg_errs else "all accepted")
            with self._lock:
                self._cfg = actual
            for e in cfg_errs:
                log.warning("  setting refused: %s", e)
                self._record_error(e)
            self._events_seen = 0      # Count reflects this acquisition run
            self._rate.reset()
            with logsetup.step(log, "arming the board"):
                self._backend.start()
            self._running.set()
            self._thread = threading.Thread(target=self._loop, name="acq", daemon=True)
            self._thread.start()

    def stop(self):
        if not self._running.is_set():
            return
        with logsetup.step(log, "stopping acquisition") as stopping:
            self._running.clear()
            if self._thread:
                self._thread.join(timeout=2.0)
            self.stop_recording()
            try:
                self._backend.stop()
            except Exception as e:
                log.error("  the board would not stop: %s", e)
                self._record_error(f"stop: {e}")
            stopping.note(f"{self._events_seen} events this run")

    def close(self):
        self.stop()
        if self._backend and self._opened:
            with logsetup.step(log, "closing the digitizer"):
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
        with logsetup.step(log, "reconnecting to the unit") as reconnecting:
            self.stop()
            self._opened = False
            self._try_open(force=True)
            if self._opened:
                reconnecting.note("connected")
            else:
                reconnecting.result("no unit found")
        return self.status()

    def _try_open(self, force: bool):
        if self._opened:
            return
        now = time.monotonic()
        if not force and now - self._last_open_attempt < C.RECONNECT_RETRY_S:
            return
        # An open is already running: leave it alone rather than starting a
        # second one on the same hardware.
        if not self._open_lock.acquire(blocking=False):
            return
        try:
            self._open_locked(force, now)
        finally:
            self._open_lock.release()

    def _open_locked(self, force: bool, now: float):
        self._last_open_attempt = now
        if self._backend is not None:
            with logsetup.step(log, "closing the previous connection",
                               level=logging.INFO if force else logging.DEBUG):
                try:
                    self._backend.close()
                except Exception as e:
                    log.debug("  previous connection would not close: %s", e)
            self._backend = None
        try:
            # An automatic retry every few seconds must not fill the log; a
            # reconnect the operator asked for must always say what happened.
            self.open(level=logging.INFO if force else logging.DEBUG)
        except Exception as e:
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
        with logsetup.step(log, f"starting a recording named {name!r}") as rec:
            if not self._running.is_set():
                self.start()
            try:
                run_id, path = runs.create(name, timestamp)
            except FileExistsError as e:
                log.error("  a run named %r already exists", e.args[0])
                return {"ok": False,
                        "error": f"a run named {e.args[0]!r} already exists - "
                                 f"rename it or switch the timestamp on"}
            with self._lock:
                cfg = self._cfg
            writer = make_writer(path, run_id)  # the directory name is the name
            try:
                with logsetup.step(log, f"opening run directory {path}"):
                    writer.open(cfg)
            except Exception as e:
                self._record_error(f"record: {e}")
                return {"ok": False, "error": str(e)}
            rec.note(run_id)
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
        with logsetup.step(log, f"closing the recording {run_id!r}") as closing:
            try:
                w.close()
            except Exception as e:
                log.error("  the writer would not close: %s", e)
                self._record_error(f"record close: {e}")
            closing.note(f"{self._recorded} events written")
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
