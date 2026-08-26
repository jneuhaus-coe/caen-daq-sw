"""A board-shaped stand-in: every setting sticks, events are synthesized.

Exists so the UI can be exercised with no unit attached - the Playwright suite
and demos both need a board that answers, and with none connected the real UI
locks every hardware control. This is NOT a simulation of DRS4 physics; it is
the minimum honest imitation of the backend contract: settings write and read
back exactly, acquisition produces plausible waveforms at a steady rate, and
software triggers add an event each.

Selected with DAQ_BACKEND=fake (see __main__); never the default.
"""
from __future__ import annotations

import time

import numpy as np

from .base import DigitizerBackend, Event, BoardInfo
from .. import constants as C

_EVENT_HZ = 5.0            # steady synthetic rate while acquiring
_NOISE_COUNTS = 3.0        # baseline jitter, roughly the real unit's floor
_PULSE_COUNTS = 800.0      # synthetic pulse amplitude


def _baseline_counts(dc_offset: int) -> float:
    """Where the baseline sits for a DAC word, nominal model: midscale at ADC
    centre, increasing DAC lowers it, the DAC spanning twice the window."""
    half = (C.ADC_MAX + 1) / 2
    return half - (dc_offset - C.DC_OFFSET_MID) / (C.DC_OFFSET_MAX + 1) * (C.ADC_MAX + 1) * 2


class FakeBackend(DigitizerBackend):
    def __init__(self):
        self._cfg = None
        self._running = False
        self._pending = 0          # queued software triggers
        self._last_emit = 0.0
        self._index = 0
        self._rng = np.random.default_rng(53364)

    def open(self) -> BoardInfo:
        return BoardInfo(model="DT5742B-SIM", family_code="fake", serial=99999,
                         roc_firmware="sim", amc_firmware="sim", sw_release="sim")

    def _copy(self, cfg):
        from ..config import BoardConfig
        return BoardConfig.from_dict(cfg.to_dict())

    # Settings stick exactly - the fake board never refuses or drifts, so any
    # mismatch a test sees is the app's own doing.
    def read_settings(self, cfg):
        if self._cfg is None:
            self._cfg = self._copy(cfg)
        return self._copy(self._cfg), []

    def write_settings(self, cfg):
        self._cfg = self._copy(cfg)
        return self._copy(cfg), []

    def configure(self, cfg):
        self._cfg = self._copy(cfg)
        return self._copy(cfg), []

    def start(self) -> None:
        self._running = True
        self._last_emit = time.monotonic()

    def stop(self) -> None:
        self._running = False
        self._pending = 0

    def trigger(self) -> None:
        self._pending += 1

    def close(self) -> None:
        self._running = False

    def _event(self) -> Event:
        cfg = self._cfg
        samples = {}
        for ch in (cfg.enabled_channels() if cfg else range(C.NUM_CHANNELS)):
            base = _baseline_counts(cfg.channels[ch].dc_offset) if cfg else 2048.0
            w = base + self._rng.normal(0.0, _NOISE_COUNTS, C.RECORD_LENGTH)
            # A negative pulse two-thirds in, so the display has a shape to show.
            t0 = int(C.RECORD_LENGTH * 0.66)
            t = np.arange(C.RECORD_LENGTH) - t0
            w -= _PULSE_COUNTS * np.exp(-0.5 * (t / 12.0) ** 2) * (t > -40)
            samples[ch] = np.clip(w, 0, C.ADC_MAX).astype(np.float32)
        if cfg and cfg.fast_trigger_digitizing:
            # The digitized TR trace, 16+group, like the real decoder: a
            # sharp negative edge where the trigger fired. Its baseline
            # follows the TR DC offset (nominal slope), so the calibrator's
            # servo has an honest response to steer.
            t = np.arange(C.RECORD_LENGTH) - int(C.RECORD_LENGTH * 0.66)
            tr_base = 2048.0 - (cfg.groups[0].fast_trigger_dc_offset - 32768) * 0.19
            tr = tr_base + self._rng.normal(0.0, _NOISE_COUNTS, C.RECORD_LENGTH)
            tr -= 1200.0 * np.exp(-0.5 * (t / 6.0) ** 2)
            for gr, g in enumerate(cfg.groups):
                if g.enabled:
                    samples[16 + gr] = np.clip(tr, 0, C.ADC_MAX).astype(np.float32)
        self._index += 1
        # A rotating trigger cell, so tc-dependent code sees realistic variety.
        tc = (self._index * 37) % 1024
        return Event(index=self._index, timestamp_s=time.time(),
                     trigger_time_tag=self._index, samples=samples,
                     trigger_cells={0: tc, 1: tc})

    def read_events(self) -> list[Event]:
        if not self._running:
            return []
        out = []
        while self._pending > 0:
            self._pending -= 1
            out.append(self._event())
        now = time.monotonic()
        if now - self._last_emit >= 1.0 / _EVENT_HZ:
            self._last_emit = now
            out.append(self._event())
        return out
