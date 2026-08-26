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
    def __init__(self, backend_factory=make_backend):
        # Injectable so tests can refuse hardware outright. The default factory
        # loads the real libCAENDigitizer, so on a machine with a unit attached
        # a "hardware-free" test would open — or hang on — the actual board.
        self._backend_factory = backend_factory
        self._backend: DigitizerBackend | None = None
        self._board_info = BoardInfo()
        self._cfg = default_config()   # only a seed; the board wins once open
        self._avg = RollingAverage()
        self._rate = TriggerRateMeter()
        # Latest single event per channel, as (event_index, wave). Telemetry
        # ships it decimated so the UI's overlay mode can accumulate a
        # density picture client-side - one trace per tick, so the stream
        # stays the same size class as the averages and can never throttle
        # data-taking. (index, wave) as one tuple: assignment is atomic, so
        # the telemetry thread never sees a wave paired with the wrong id.
        self._last: dict[int, tuple[int, np.ndarray]] = {}
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
        # Software triggers are queued here and fired by the readout loop, one
        # per pass at the requested pace. Firing from the request thread that
        # asked for them would put a second thread inside libCAENDigitizer
        # while the loop is in ReadData on the same handle.
        self._sw_pending = 0
        self._sw_interval_s = 0.0
        self._sw_next_fire = 0.0

    # ---------- lifecycle ----------
    def open(self, level: int = logging.INFO):
        with self._open_lock:
            with logsetup.step(log, "Opening the digitizer", level=level) as opening:
                backend = self._backend_factory()
                board_info = backend.open()
                self._backend = backend
                self._board_info = board_info
                opening.done(f"Found {board_info.model} S/N {board_info.serial}, "
                             f"ROC {board_info.roc_firmware}, "
                             f"AMC {board_info.amc_firmware}")

            # The board, not our last-used file, is the source of truth.
            with logsetup.step(log, "Reading settings off the unit",
                               level=level) as reading:
                cfg, errs = backend.read_settings(self._cfg)
                for e in errs:
                    log.warning("%sCould not read: %s", "  ", e)
                    self._record_error(f"read settings: {e}")
                reading.done(f"{len(errs)} settings could not be read" if errs
                             else "All settings read")
            with self._lock:
                self._cfg = cfg
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
        with logsetup.step(log, "Writing settings to the unit") as writing:
            try:
                cfg, errors = self._backend.write_settings(cfg)
            except Exception as e:
                errors = [f"write settings: {e}"]
            for e in errors:
                log.warning("%s%s", "  ", e)
                self._record_error(e)
            writing.done(f"{len(errors)} settings refused or read back wrong"
                         if errors else "All settings accepted and read back")
        with self._lock:
            self._cfg = cfg
        return cfg

    def start(self):
        if self._running.is_set():
            return
        with logsetup.step(log, "Starting acquisition") as starting:
            if not self._opened:
                try:
                    self.open()
                except Exception as e:
                    # Refuse rather than raise: with no unit there is nothing to
                    # acquire, and a traceback through the API tells the
                    # operator nothing the badge does not already say.
                    starting.done("Not started: no unit connected")
                    self._record_error(f"start: {e}")
                    return
            with self._lock:
                cfg = self._cfg
            with logsetup.step(log, "Applying settings to the unit") as applying:
                actual, cfg_errs = self._backend.configure(cfg)
                for e in cfg_errs:
                    log.warning("%sRefused: %s", "  ", e)
                    self._record_error(e)
                applying.done(f"{len(cfg_errs)} settings refused" if cfg_errs
                              else "All settings accepted")
            with self._lock:
                self._cfg = actual
            self._events_seen = 0      # Count reflects this acquisition run
            self._rate.reset()
            self._backend.start()
            logsetup.did(log, "Arming the board", "Ok")
            self._running.set()
            self._thread = threading.Thread(target=self._loop, name="acq", daemon=True)
            self._thread.start()
            starting.done("Acquisition running")

    def fire_software_triggers(self, count: int = 1, rate_hz: float = 10.0) -> dict:
        """Queue `count` software triggers for the readout loop to fire.

        The bench check with no signal source: the x742 cannot self-trigger, so
        the board is poked from software instead. Starts acquisition if the
        operator has not already, the same courtesy start_recording extends.
        """
        if not self._running.is_set():
            self.start()
        if not self._running.is_set():           # start() refused: no unit
            return {"ok": False, "error": "no unit connected"}
        with self._lock:
            mode = self._cfg.software_trigger
        if mode == "disabled":
            # The board would swallow every SendSWtrigger without a trace;
            # say so now instead of reporting 100 triggers that did nothing.
            return {"ok": False, "error": "the software trigger is disabled "
                                          "in the unit settings"}
        count = max(1, min(int(count), 100_000))
        rate_hz = min(max(float(rate_hz), 0.1), 1000.0)
        with self._lock:
            self._sw_pending += count
            self._sw_interval_s = 1.0 / rate_hz
        logsetup.did(log, f"Queueing {count} software triggers at {rate_hz:g} Hz", "Ok")
        return {"ok": True, "queued": count, "rate_hz": rate_hz}

    def _fire_due_software_trigger(self):
        """One trigger per loop pass, no sooner than the requested pace."""
        with self._lock:
            due = self._sw_pending > 0 and time.monotonic() >= self._sw_next_fire
            if due:
                self._sw_pending -= 1
                self._sw_next_fire = time.monotonic() + self._sw_interval_s
        if not due:
            return
        try:
            self._backend.trigger()
        except Exception as e:
            with self._lock:
                self._sw_pending = 0    # one report, not one per queued trigger
            self._record_error(f"software trigger: {e}")

    def stop(self):
        if not self._running.is_set():
            return
        with self._lock:
            self._sw_pending = 0        # owed triggers die with the acquisition
        with logsetup.step(log, "Stopping acquisition") as stopping:
            self._running.clear()
            if self._thread:
                self._thread.join(timeout=2.0)
            self.stop_recording()
            try:
                self._backend.stop()
            except Exception as e:
                log.error("%sThe board would not stop: %s", "  ", e)
                self._record_error(f"stop: {e}")
            stopping.done(f"Acquisition stopped after {self._events_seen} events")

    def close(self):
        self.stop()
        if self._backend and self._opened:
            self._backend.close()
            logsetup.did(log, "Closing the digitizer", "Ok")
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
        with logsetup.step(log, "Reconnecting to the unit") as reconnecting:
            self.stop()
            self._opened = False
            self._try_open(force=True)
            reconnecting.done("Reconnected" if self._opened else "No unit found")
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
            closed = "Ok"
            try:
                self._backend.close()
            except Exception as e:
                closed = f"would not close ({e})"
            logsetup.did(log, "Closing the previous connection", closed,
                         level=logging.INFO if force else logging.DEBUG)
            self._backend = None
        try:
            # An automatic retry every few seconds must not fill the log; a
            # reconnect the operator asked for must always say what happened.
            self.open(level=logging.INFO if force else logging.DEBUG)
        except Exception as e:
            if force:
                self._record_error(f"reconnect: {e}")

    # ---------- recording ----------
    def start_recording(self, name: str, timestamp: bool = True,
                        run_number: int | None = None) -> dict:
        """Begin writing to a new run directory, starting acquisition if the
        operator has not already. Watching and recording are separate actions.

        The run number is the analysis-facing identity (run_<N>.root): given
        explicitly it is taken as-is; otherwise it is one past the highest
        number already in the data directory."""
        if self._writer is not None:
            return {"ok": False, "error": "already recording"}
        if not self._opened:
            return {"ok": False, "error": "no unit connected"}
        if run_number is None:
            run_number = runs.next_run_number()
        with logsetup.step(log, f"Starting a recording named {name!r} "
                                f"(run {run_number})") as rec:
            if not self._running.is_set():
                self.start()
            try:
                run_id, path = runs.create(name, timestamp)
            except FileExistsError as e:
                rec.done(f"Not started: a run named {e.args[0]!r} already exists")
                return {"ok": False,
                        "error": f"a run named {e.args[0]!r} already exists - "
                                 f"rename it or switch the timestamp on"}
            with self._lock:
                cfg = self._cfg
            writer = make_writer(path, run_id, cfg.output_format, run_number)
            try:
                writer.open(cfg)
                logsetup.did(log, "Creating the run directory", path)
            except Exception as e:
                self._record_error(f"record: {e}")
                return {"ok": False, "error": str(e)}
            rec.done(f"Recording to {run_id}")
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
        with logsetup.step(log, f"Closing the recording {run_id!r}") as closing:
            try:
                w.close()
            except Exception as e:
                log.error("%sThe writer would not close: %s", "  ", e)
                self._record_error(f"record close: {e}")
            closing.done(f"Wrote {self._recorded} events")
        self._run_id = None
        self._run_started = None
        return {"ok": True, "run": run_id}

    # ---------- readout loop ----------
    def _loop(self):
        fails = 0
        while self._running.is_set():
            self._fire_due_software_trigger()
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
                    self._last[ch] = (ev.index, wave)
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
            entry = {
                "wave": decimate(mean, C.OVERVIEW_POINTS),
                "count": count,
                "vpp": vpp,
                "min": float(mean.min()),
                "max": float(mean.max()),
                "baseline": float(np.median(mean)),
            }
            last = self._last.get(ch)
            if last is not None:
                # One single-event trace per tick for the overlay display; the
                # id lets the client add each event once, not once per render.
                entry["last"] = decimate(last[1], C.OVERVIEW_POINTS)
                entry["last_index"] = last[0]
            channels[str(ch)] = entry
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
            "sw_triggers_pending": self._sw_pending,
            "recording": self._writer is not None,
            "run_id": self._run_id,
            "run_started": self._run_started,
            "recorded": self._recorded,
            "data_dir": runs.DATA_ROOT,
            "next_run_number": runs.next_run_number(),
            "errors": list(self._errors),
        }
