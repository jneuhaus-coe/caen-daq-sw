"""Closed-loop channel calibration: the board's own response is the truth.

Two modes, both polarity-agnostic by design - some positive pulses carry a
negative afterpulse, so no polarity flag can be trusted; the data says where
the pulse goes, not a setting:

- "shift" (Pulse Shift): real triggers flowing. Every channel goes to 0 V of
  offset (0x8F00) and its pulses are measured. A channel whose pulses fit
  the ADC window there STAYS there - this never centres anything. Only a
  clipped channel moves, and only as far as it takes to bring the whole
  pulse (afterpulses included) inside the window with a small margin. A
  pulse bigger than the window is reported as no_fit: no offset can fix
  that, only attenuation. TR0 is not touched: its threshold is only
  defined at midscale 0x8000.
- "zero": every input unplugged or terminated - a KNOWN 0 V. Measures the
  ADC code each channel reads at 0x8F00 and each TR0 copy at 0x8000 (their
  0 V of offset) and stores it per serial (zerocal.py) for the display,
  which moves it with the NOMINAL slope. Steers nothing: the operator's
  settings are restored afterwards.

(A third mode, "baseline", servoed every baseline to the window centre on a
dark bench; the zero calibration supplants it and it was removed.)

The servo slope starts from the nominal counts-per-LSB and switches to the
measured secant after the first step, so each channel calibrates its own
response.
"""
from __future__ import annotations

import threading
import time
from dataclasses import dataclass

from . import constants as C
from . import logsetup
from . import zerocal

log = logsetup.get("daq.calib")

ADC_TOP = C.ADC_MAX                  # 4095
CENTER = (C.ADC_MAX + 1) / 2         # 2048
TOL_COUNTS = 20                      # ~5 mV: within the noise, out of the way
MAX_ITER = 6
MARGIN_FRAC = 0.05                   # spare window kept clear on each side
RAIL_LO, RAIL_HI = 2, ADC_TOP - 2    # excursions here mean "clipped, or worse"
# Nominal servo slopes in ADC counts per DAC LSB (negative: a larger DAC word
# lowers the baseline). Replaced by the measured secant after one step.
SLOPE_CH = -0.125
SLOPE_TR = -0.19
# The TR threshold is RAW (operator's convention, 2026-08-28): an absolute
# level on the same volt scale as the TR offset, never adjusted behind the
# operator's back. When the servo moves the TR offset, the trigger's
# effective depth changes and the operator re-checks it - by design.

TR_KEY = "TR0"

# Zero mode: one point per input, at its 0 V of offset - signal channels at
# C.DC_OFFSET_ZERO (0x8F00), TR0 at midscale 0x8000 - and what "quiet"
# means: a terminated input's peak-to-peak over all events. A pulse or a
# ripple blows straight past it.
ZERO_CH_DAC = C.DC_OFFSET_ZERO
ZERO_TR_DAC = C.DC_OFFSET_MID
ZERO_QUIET_PP = 200            # counts, ~49 mV of window


class _Cancelled(Exception):
    """The operator asked the run to stop; not an error."""


def _counts_to_mv(counts: float) -> float:
    return (counts - CENTER) / (C.ADC_MAX + 1) * 1000.0


@dataclass
class _Servo:
    """One DAC being steered: a signal channel or the shared TR0 offset."""
    key: str                     # "0".."15" or TR_KEY
    stat_ch: int                 # where its baseline is measured in events
    target: float                # counts
    slope: float
    dac: int = 0
    baseline: float | None = None
    prev: tuple[int, float] | None = None    # (dac, baseline) for the secant
    status: str = "adjusting"
    below: float = 0.0           # measured excursions, shift phase
    above: float = 0.0
    low_side: bool = False       # Pulse Shift: clipped at the bottom rail

    def report(self) -> dict:
        return {"channel": f"CH {self.key}" if self.key != TR_KEY else TR_KEY,
                "dac": self.dac,
                "baseline_mv": round(_counts_to_mv(self.baseline), 1)
                if self.baseline is not None else None,
                "below_mv": round(self.below / (C.ADC_MAX + 1) * 1000.0, 1),
                "above_mv": round(self.above / (C.ADC_MAX + 1) * 1000.0, 1),
                "status": self.status}


class Calibrator:
    """Owns one calibration run at a time; state is what the UI polls."""

    # Overridable per instance - the tests shrink them to keep suites fast,
    # and the UI passes the operator's count for a fit run.
    baseline_events = 24
    fit_events = 100
    # Event-count-driven, not time-driven: a measurement waits for its events
    # however long they take. The only clock is the stall detector - this
    # long with NO events means nothing is triggering, and the run stops with
    # an honest count instead of fitting on scraps.
    stall_s = 30.0
    # After an adjustment pass, 17 DAC writes sit on the mezzanine's slow SPI
    # and the baselines SLEW through the next moments. Measuring during the
    # slew poisoned every number on the first live run - quiet channels
    # reported 250 mV "excursions" that were the baseline in flight, and the
    # secant learned garbage slopes from them. Let the board settle first.
    settle_s = 0.6

    def __init__(self, engine):
        self._engine = engine
        self._lock = threading.Lock()
        self._thread: threading.Thread | None = None
        self._abort = threading.Event()
        self._state = {"active": False, "phase": None, "message": "",
                       "iteration": 0, "report": [], "error": None}

    def status(self) -> dict:
        with self._lock:
            return dict(self._state, report=list(self._state["report"]))

    def is_active(self) -> bool:
        with self._lock:
            return self._state["active"]

    def start(self, mode: str, events: int | None = None) -> dict:
        if mode not in ("shift", "zero"):
            return {"ok": False, "error": f"unknown calibration mode {mode!r}"}
        if events:
            events = max(4, min(100_000, int(events)))
            if mode == "shift":
                self.fit_events = events
        if self._engine.status()["recording"]:
            return {"ok": False, "error": "a run is recording - stop it first"}
        with self._lock:
            if self._state["active"]:
                return {"ok": False, "error": "a calibration is already running"}
            self._state = {"active": True, "phase": mode, "message": "starting",
                           "iteration": 0, "report": [], "error": None}
        self._abort.clear()
        self._thread = threading.Thread(target=self._run, args=(mode,),
                                        name="calib", daemon=True)
        self._thread.start()
        return {"ok": True}

    def cancel(self) -> dict:
        """End a run at the next safe point; the board keeps whatever the
        last completed pass wrote - never a half-applied one."""
        if not self.is_active():
            return {"ok": False, "error": "no calibration is running"}
        self._abort.set()
        return {"ok": True}

    # ---------- the run ----------
    def _run(self, mode: str) -> None:
        try:
            with logsetup.step(log, f"Calibrating ({mode})") as step:
                if mode == "zero":
                    step.done(self._zero())
                    return
                servos = self._make_servos()
                self._shift(servos)
                moved = [s.key for s in servos if s.status == "shifted"]
                bad = [s.key for s in servos if s.status not in ("ok", "shifted")]
                step.done(f"{len(servos) - len(moved) - len(bad)} of {len(servos)} "
                          "channels fit at 0 V of offset"
                          + (f"; shifted: {', '.join(moved)}" if moved else "")
                          + (f"; needs attention: {', '.join(bad)}" if bad else ""))
        except _Cancelled:
            log.info("calibration cancelled")
            with self._lock:
                self._state["message"] = "cancelled"
                self._state["active"] = False
            return
        except Exception as e:
            log.error("calibration failed: %s", e)
            with self._lock:
                self._state["error"] = str(e)
        finally:
            with self._lock:
                self._state["active"] = False
                if self._state["message"] != "cancelled":
                    self._state["message"] = "done"

    def _say(self, msg: str, iteration: int | None = None) -> None:
        with self._lock:
            self._state["message"] = msg
            if iteration is not None:
                self._state["iteration"] = iteration

    def _publish(self, servos: list[_Servo]) -> None:
        with self._lock:
            self._state["report"] = [s.report() for s in servos]

    def _make_servos(self) -> list[_Servo]:
        cfg = self._engine.get_config()
        # Signal channels only: TR0 stays at midscale, where its threshold
        # is defined.
        servos = [
            _Servo(key=str(ch), stat_ch=ch, target=CENTER, slope=SLOPE_CH,
                   dac=cfg.channels[ch].dc_offset)
            for ch in cfg.enabled_channels()
        ]
        if not servos:
            raise RuntimeError("no enabled channels to calibrate")
        return servos

    def _measure(self, servos: list[_Servo], events: int, fire_sw: bool) -> None:
        base_msg = self.status()["message"]
        stats, seen = self._engine.collect_stats(
            events, fire_sw, stall_s=self.stall_s, abort=self._abort,
            progress=lambda n: self._say(f"{base_msg} - {n}/{events} events"))
        if self._abort.is_set():
            raise _Cancelled()
        if seen < events:
            # The stall detector fired: nothing has triggered for stall_s.
            # Better an honest stop than a fit built on scraps.
            raise RuntimeError(
                f"only {seen} of {events} events, then nothing for "
                f"{self.stall_s:.0f}s - is anything triggering?")
        missing = [s.key for s in servos if s.stat_ch not in stats]
        if missing:
            raise RuntimeError("no events carried data for " + ", ".join(missing))
        for s in servos:
            st = stats[s.stat_ch]
            s.baseline = st["baseline"]
            s.below = max(0.0, st["baseline"] - st["min"])
            s.above = max(0.0, st["max"] - st["baseline"])

    def _apply(self, servos: list[_Servo]) -> None:
        """Write the DACs while acquisition is STOPPED, then re-arm.

        Measured on serial 53364: a DC-offset write during acquisition
        updates the register - readback agrees, no error anywhere - but the
        analog output NEVER moves until the next arm. Two servo runs chased
        frozen baselines for six passes each before this was understood. So:
        stop, write, start (arming rewrites every setting while stopped,
        which is when the DACs actually load), and only then measure."""
        eng = self._engine
        eng.stop()
        cfg = eng.get_config()
        for s in servos:
            if s.key == TR_KEY:
                # RAW threshold semantics (operator's convention): the
                # threshold DAC is never touched behind the operator's back.
                # An offset move changes the trigger's effective depth, so
                # the report's status line - not a silent compensation - is
                # what says "re-check your threshold".
                for g in cfg.groups:      # one TR0, both banks' registers
                    g.fast_trigger_dc_offset = s.dac
            else:
                cfg.channels[int(s.key)].dc_offset = s.dac
        got, _ = eng.set_config(cfg)   # write errors already land in status
        for s in servos:                  # the board's answer is the truth
            s.dac = (got.groups[0].fast_trigger_dc_offset if s.key == TR_KEY
                     else got.channels[int(s.key)].dc_offset)
        eng.start()                       # the arm loads the DACs
        time.sleep(self.settle_s)         # and the SPI drains before we judge

    def _servo(self, servos: list[_Servo], fire_sw: bool) -> None:
        """Steer every servo to its target; the measured secant replaces the
        nominal slope as soon as a step's response has been observed."""
        for it in range(1, MAX_ITER + 1):
            self._say(f"measuring baselines (pass {it})", it)
            self._measure(servos, self.baseline_events, fire_sw)
            moving = []
            for s in servos:
                err = s.target - s.baseline
                if s.prev is not None:
                    d_dac, d_base = s.dac - s.prev[0], s.baseline - s.prev[1]
                    if abs(d_dac) >= 8 and abs(d_base) >= 4:
                        cand = d_base / d_dac
                        # A physical slope on this hardware is negative and of
                        # order -0.1 counts/LSB; anything else is a poisoned
                        # measurement and must not steer the loop.
                        if -0.6 <= cand <= -0.03:
                            s.slope = cand
                if abs(err) <= TOL_COUNTS:
                    s.status = "ok"
                    continue
                s.prev = (s.dac, s.baseline)
                want = s.dac + err / s.slope
                s.dac = int(min(C.DC_OFFSET_MAX, max(0, round(want))))
                s.status = ("unreachable"
                            if s.dac in (0, C.DC_OFFSET_MAX) and want != s.dac
                            else "adjusting")
                moving.append(s)
            self._publish(servos)
            if not moving:
                return
            self._say(f"adjusting {len(moving)} channels (pass {it})", it)
            self._apply(moving)
        for s in servos:
            if s.status == "adjusting":
                s.status = "unreachable"
        self._publish(servos)

    def _shift(self, servos: list[_Servo]) -> None:
        """Pulse Shift: 0 V of offset unless the pulse does not fit there.

        Round 1 measures every channel at 0x8F00; channels that fit are done.
        A clipped channel is first pushed as far as its unclipped side allows
        (a clipped excursion under-reports its true extent), re-measured, and
        then placed with the SMALLEST shift that keeps the whole pulse inside
        the window with margin - as close to 0 V of offset as it can be."""
        margin = (C.ADC_MAX + 1) * MARGIN_FRAC
        self._say("setting 0 V of offset")
        for s in servos:
            s.dac = C.DC_OFFSET_ZERO
        self._apply(servos)
        self._say("measuring pulses at 0 V of offset")
        self._measure(servos, self.fit_events, fire_sw=False)
        clipped = []
        for s in servos:
            lo_rail = (s.baseline - s.below) <= RAIL_LO
            hi_rail = (s.baseline + s.above) >= RAIL_HI
            if lo_rail and hi_rail:
                s.status = "no_fit"
            elif lo_rail or hi_rail:
                s.prev = None
                s.status = "adjusting"
                s.low_side = lo_rail
                # Push away from the clipped rail as far as the other side
                # allows, so the next measurement sees the whole pulse.
                s.target = (ADC_TOP - margin - s.above) if lo_rail else (margin + s.below)
                clipped.append(s)
            else:
                s.status = "ok"
        self._publish(servos)
        if not clipped:
            return
        self._servo(clipped, fire_sw=False)
        self._say("measuring the unclipped pulses")
        self._measure(clipped, self.fit_events, fire_sw=False)
        for s in clipped:
            if s.below + s.above + 2 * margin > C.ADC_MAX + 1:
                s.status = "no_fit"
                continue
            # The smallest move from 0 V of offset: the clipped side ends up
            # just margin inside its rail.
            s.target = (margin + s.below) if s.low_side else (ADC_TOP - margin - s.above)
            s.prev = None
            s.status = "adjusting"
        moving = [s for s in clipped if s.status == "adjusting"]
        if moving:
            self._servo(moving, fire_sw=False)
            self._say("verifying")
            self._measure(moving, self.fit_events, fire_sw=False)
            for s in moving:
                if ((s.baseline - s.below) <= RAIL_LO
                        or (s.baseline + s.above) >= RAIL_HI):
                    s.status = "clipped"
                elif s.status != "unreachable":
                    s.status = "shifted"
        self._publish(servos)

    # ---------- zero mode ----------
    zero_events = 40

    def _zero(self) -> str:
        """Measure each input's 0 V code at its 0 V of offset, save it per
        serial, and put the operator's configuration back exactly."""
        eng = self._engine
        st = eng.status()
        serial = st["board"]["serial"]
        if not st["opened"] or not serial:
            raise RuntimeError("no unit connected")
        was_running = st["running"]
        orig = eng.get_config()
        try:
            self._say("measuring 0 V", 1)
            cfg = eng.get_config()
            cfg.fast_trigger_digitizing = True
            cfg.external_trigger = "disabled"    # nothing but our own
            cfg.fast_trigger = "disabled"        # software triggers
            cfg.software_trigger = "acquisition_only"
            for g in cfg.groups:
                g.enabled = True
                g.fast_trigger_dc_offset = ZERO_TR_DAC
            for c in cfg.channels:
                c.dc_offset = ZERO_CH_DAC
            eng.stop()                    # never write while acquiring
            eng.set_config(cfg)
            eng.start()                   # the arm loads the DACs
            time.sleep(self.settle_s)
            stats, seen = eng.collect_stats(
                self.zero_events, True, stall_s=self.stall_s, abort=self._abort,
                progress=lambda n: self._say(
                    f"measuring 0 V - {n}/{self.zero_events} events"))
            if self._abort.is_set():
                raise _Cancelled()
            if seen < self.zero_events:
                raise RuntimeError(f"only {seen} of {self.zero_events} events arrived")
        finally:
            eng.stop()
            eng.set_config(orig)
            if was_running:
                eng.start()
        rows, channels, noisy = [], {}, []
        for ch in sorted(stats):
            p = stats[ch]
            tr = ch >= C.NUM_CHANNELS
            name = f"TR0 (bank {ch - C.NUM_CHANNELS})" if tr else f"CH {ch}"
            ref = ZERO_TR_DAC if tr else ZERO_CH_DAC
            status = "ok"
            if p["max"] - p["min"] > ZERO_QUIET_PP:
                status = "not quiet"
                noisy.append(name)
            elif p["baseline"] <= RAIL_LO or p["baseline"] >= RAIL_HI:
                status = "railed"
            if status == "ok":
                channels[str(ch)] = {"zero_code": round(p["baseline"], 2), "ref_dac": ref}
            rows.append({"channel": name, "zero_code": round(p["baseline"], 1),
                         "ref_dac": ref, "status": status})
        with self._lock:
            self._state["report"] = rows
        if noisy:
            raise RuntimeError(
                "not saved - " + ", ".join(noisy) + " saw a signal, not 0 V. "
                "Unplug every input (or terminate it in 50 ohm) and run again.")
        if not channels:
            raise RuntimeError("not saved - no channel gave a usable 0 V")
        zerocal.save(serial, channels, {
            "method": "all inputs unplugged/terminated; median code over "
                      f"{self.zero_events} software triggers, channels at DC "
                      f"offset 0x{ZERO_CH_DAC:04X}, TR0 at 0x{ZERO_TR_DAC:04X}; "
                      "the display moves it with the nominal slope",
            "correction_level": orig.correction_level,
            "drs4_frequency": orig.drs4_frequency,
        })
        bad = [r["channel"] for r in rows if r["status"] != "ok"]
        return (f"0 V found for {len(channels)} of {len(rows)} inputs"
                + (f"; skipped: {', '.join(bad)}" if bad else ""))
