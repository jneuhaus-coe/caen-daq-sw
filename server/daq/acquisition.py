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
            with logsetup.step(log, "Opening the digitizer", level=level) as opening:
                backend = make_backend()
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

    def set_config(self, cfg: BoardConfig) -> tuple[BoardConfig, list[str]]:
        """Push to the board and adopt what it reports back.

        Returns (actual config, errors from this call). The errors are returned
        rather than left for the caller to recover from `status()`: that list is
        a capped ring, so once it is full a diff of it reports no errors at all
        and a refused write reads as a success.
        """
        if not self._opened or self._backend is None:
            # Nothing was sent anywhere. Returning the requested config here
            # would have the UI show - and confirm - a value the unit never
            # received, and it would be discarded anyway the moment we reopen
            # and read the unit's own settings.
            err = "no unit connected: settings were not applied"
            log.warning("settings not applied: no unit connected")
            self._record_error(err)
            with self._lock:
                return self._cfg, [err]

        with logsetup.step(log, "Writing settings to the unit") as writing:
            try:
                actual, errors = self._backend.write_settings(cfg)
            except Exception as e:
                # The write blew up part-way, so what the board now holds is
                # unknown. Keeping the requested config would show - and
                # confirm - settings that may never have landed.
                with self._lock:
                    actual = self._cfg
                errors = [f"write settings: {e}; showing the last confirmed settings"]
            for e in errors:
                log.warning("%s%s", "  ", e)
                self._record_error(e)
            writing.done(f"{len(errors)} settings refused or read back wrong"
                         if errors else "All settings accepted and read back")
        with self._lock:
            self._cfg = actual
        return actual, errors

    def start(self) -> bool:
        """Arm the board and begin reading out. True if acquisition is running.

        Every failure here is refused, never raised: an exception through the
        API produces a full ASGI traceback in the log and a 500 in the UI,
        neither of which says anything the error list does not.
        """
        if self._running.is_set():
            return True
        with logsetup.step(log, "Starting acquisition") as starting:
            if not self._opened:
                try:
                    self.open()
                except Exception as e:
                    starting.done("Not started: no unit connected")
                    self._record_error(f"start: {e}")
                    return False
            with self._lock:
                cfg = self._cfg
            with logsetup.step(log, "Applying settings to the unit") as applying:
                try:
                    actual, cfg_errs = self._backend.configure(cfg)
                except Exception as e:
                    # Reset() has already wiped the board by the time most of
                    # configure() can fail, so say that rather than let the
                    # caller assume the unit is untouched.
                    applying.done(f"Could not apply them: {e}")
                    self._record_error(f"configure: {e}")
                    starting.done("Not started: the unit would not take its settings")
                    return False
                for e in cfg_errs:
                    log.warning("%sRefused: %s", "  ", e)
                    self._record_error(e)
                applying.done(f"{len(cfg_errs)} settings refused" if cfg_errs
                              else "All settings accepted")
            with self._lock:
                self._cfg = actual
            self._events_seen = 0      # Count reflects this acquisition run
            self._rate.reset()
            try:
                self._backend.start()
            except Exception as e:
                logsetup.did(log, "Arming the board", f"Refused: {e}",
                             level=logging.ERROR)
                self._record_error(f"arm: {e}")
                starting.done("Not started: the board would not arm")
                return False
            logsetup.did(log, "Arming the board", "Ok")
            self._running.set()
            self._thread = threading.Thread(target=self._loop, name="acq", daemon=True)
            self._thread.start()
            starting.done("Acquisition running")
            return True

    def stop(self):
        if not self._running.is_set():
            return
        with logsetup.step(log, "Stopping acquisition") as stopping:
            self._running.clear()
            # Before the join, not after: this clears the writer, so the loop
            # stops writing at once and its own end-of-run cleanup (which is
            # written for a LOST board) finds nothing left to report.
            self.stop_recording()
            if self._thread:
                self._thread.join(timeout=2.0)
            halted = True
            if self._backend is not None:
                try:
                    self._backend.stop()
                except Exception as e:
                    halted = False
                    log.error("%sThe board would not stop: %s", "  ", e)
                    self._record_error(f"stop: {e}")
            stopping.done(
                f"Readout stopped after {self._events_seen} events"
                + ("" if halted else "; the board is still armed"))

    def close(self):
        self.stop()
        if self._backend and self._opened:
            try:
                self._backend.close()
                logsetup.did(log, "Closing the digitizer", "Ok")
            except Exception as e:
                logsetup.did(log, "Closing the digitizer", f"Failed: {e}",
                             level=logging.ERROR)
                self._record_error(f"close: {e}")
            finally:
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
    def start_recording(self, name: str, timestamp: bool = True) -> dict:
        """Begin writing to a new run directory, starting acquisition if the
        operator has not already. Watching and recording are separate actions."""
        if self._writer is not None:
            return {"ok": False, "error": "already recording"}
        if not self._opened:
            return {"ok": False, "error": "no unit connected"}
        with logsetup.step(log, f"Starting a recording named {name!r}") as rec:
            # Acquisition must actually be running, or this opens a run that can
            # never receive an event and reports it as a success.
            if not self._running.is_set() and not self.start():
                rec.done("Not started: acquisition would not start")
                return {"ok": False,
                        "error": "acquisition would not start - see the errors below"}
            try:
                run_id, path = runs.create(name, timestamp)
            except FileExistsError as e:
                rec.done(f"Not started: a run named {e.args[0]!r} already exists")
                return {"ok": False,
                        "error": f"a run named {e.args[0]!r} already exists - "
                                 f"rename it or switch the timestamp on"}
            except OSError as e:
                rec.done(f"Not started: could not create the run directory: {e}")
                self._record_error(f"record: {e}")
                return {"ok": False, "error": f"could not create the run directory: {e}"}
            with self._lock:
                cfg = self._cfg
            writer = make_writer(path, run_id)  # the directory name is the name
            try:
                writer.open(cfg)
                logsetup.did(log, "Creating the run directory", path)
            except Exception as e:
                # The directory exists but holds nothing; leaving it behind puts
                # an empty run in the listing that was never recorded.
                runs.discard_empty(run_id)
                rec.done(f"Not started: could not open the run files: {e}")
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
        try:
            self._read_loop()
        except Exception as e:
            # This thread has no owner to raise into. Left unhandled, it died in
            # silence: events stopped arriving while the UI went on saying
            # "acquiring", and nothing anywhere said why.
            log.exception("The readout thread stopped unexpectedly")
            self._record_error(f"readout stopped: {e}")
            self._running.clear()
        finally:
            if self._writer is not None:
                self._end_recording_from_loop(
                    "board stopped responding" if not self._opened
                    else "readout stopped")

    def _read_loop(self):
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
                # A write failure is a DISK failure. Reporting it as a read
                # error blamed the board for a full or unwritable filesystem,
                # and ten of them halted a perfectly healthy acquisition.
                writer = self._writer
                if writer is not None:
                    try:
                        writer.write(ev)
                        self._recorded += 1
                    except Exception as e:
                        self._end_recording_from_loop(f"could not write: {e}")
            self._rate.add(len(events))

    def _end_recording_from_loop(self, why: str):
        """Close a recording from the readout thread and say why it stopped."""
        w, run_id = self._writer, self._run_id
        self._writer = None            # first: nothing else tries to write
        if w is None:
            return
        try:
            w.close()
        except Exception as e:
            self._record_error(f"record close: {e}")
        self._record_error(f"recording {run_id!r} cut short: {why}")
        log.error("Recording %r stopped after %d events: %s",
                  run_id, self._recorded, why)
        self._run_id = None
        self._run_started = None

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
