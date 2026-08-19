"""Synthetic 742 backend.

Generates plausible DRS4-style waveforms so the entire stack (server, stats,
writer, UI) runs and can be developed/tested with no hardware. Each enabled
channel gets a decaying-exponential pulse on a baseline, with per-event jitter,
amplitude spread, and Gaussian noise. Trigger times follow a Poisson process at
a configurable rate.
"""
from __future__ import annotations

import time
import numpy as np

from .base import DigitizerBackend, Event, BoardInfo
from .. import constants as C


class SimulatorBackend(DigitizerBackend):
    def __init__(self, rate_hz: float = 200.0, seed: int | None = 12345):
        self.rate_hz = float(rate_hz)
        self._rng = np.random.default_rng(seed)
        self._cfg = None
        self._running = False
        self._index = 0
        self._t0 = 0.0
        self._last_read = 0.0
        # per-channel static character so the display looks non-trivial
        self._amp = {}
        self._tau = {}
        self._t_peak = {}

    def open(self) -> BoardInfo:
        return BoardInfo(
            model="DT5742B (SIMULATOR)", family_code="XX742", serial=0,
            roc_firmware="04.29 build 8716", amc_firmware="01.06 build 6530",
            sw_release="simulator",
        )

    def configure(self, cfg) -> None:
        self._cfg = cfg
        n = cfg.record_length
        for ch in range(C.NUM_CHANNELS):
            self._amp.setdefault(ch, self._rng.uniform(300, 900))
            self._tau.setdefault(ch, self._rng.uniform(n * 0.04, n * 0.12))
            self._t_peak.setdefault(ch, self._rng.uniform(n * 0.25, n * 0.5))

    def start(self) -> None:
        self._running = True
        self._t0 = time.monotonic()
        self._last_read = self._t0

    def stop(self) -> None:
        self._running = False

    def close(self) -> None:
        self._running = False

    # channels the simulator pretends are dead, so the overview grid has
    # something to reveal (kept trivial on purpose — the sim models no physics).
    DEAD_CHANNELS = frozenset({3, 11})

    def _make_waveform(self, ch: int, n: int) -> np.ndarray:
        baseline = 2048.0 + self._cfg.channels[ch].dc_offset * 0.03
        t = np.arange(n, dtype=np.float32)
        if ch in self.DEAD_CHANNELS:
            return (baseline + self._rng.normal(0, 6, size=n)).astype(np.float32)
        t_peak = self._t_peak[ch] + self._rng.normal(0, 3)
        tau = self._tau[ch]
        amp = self._amp[ch] * self._rng.uniform(0.85, 1.15)
        pulse = np.where(t >= t_peak, -amp * np.exp(-(t - t_peak) / tau), 0.0)
        rise = np.where((t < t_peak) & (t > t_peak - 8),
                        -amp * (t - (t_peak - 8)) / 8.0, 0.0)
        wave = baseline + pulse + rise + self._rng.normal(0, 6, size=n)
        return wave.astype(np.float32)

    def read_events(self) -> list[Event]:
        if not self._running or self._cfg is None:
            return []
        now = time.monotonic()
        dt = now - self._last_read
        self._last_read = now
        # Poisson number of triggers in the elapsed window
        n_trig = self._rng.poisson(self.rate_hz * dt)
        n_trig = int(min(n_trig, self._cfg.max_events_blt))
        events = []
        enabled = self._cfg.enabled_channels()
        n = self._cfg.record_length
        for _ in range(n_trig):
            self._index += 1
            samples = {ch: self._make_waveform(ch, n) for ch in enabled}
            events.append(Event(
                index=self._index,
                timestamp_s=time.time(),
                trigger_time_tag=int((now - self._t0) * 1e9) & 0xFFFFFFFF,
                samples=samples,
            ))
        return events
