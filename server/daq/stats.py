"""Live stats on the acquisition thread: time-windowed average waveforms and a
fixed rolling trigger-rate window. Cheap enough never to throttle readout."""
from __future__ import annotations

import threading
import time
from collections import deque

import numpy as np

from . import constants as C


def decimate(wave: np.ndarray, points: int) -> list[float]:
    """Block-mean downsample to ~points (averaged waveforms are smooth, so mean
    binning preserves pulse shape). Returns a plain list for JSON."""
    n = len(wave)
    if n <= points:
        return wave.astype(float).tolist()
    step = n // points
    trimmed = wave[: step * points]
    return trimmed.reshape(points, step).mean(axis=1).astype(float).tolist()


class RollingAverage:
    """Per-channel mean over a rolling *time* window (last `window_s` seconds of
    triggers), so the displayed average is rate-independent and needs no slider."""

    def __init__(self, window_s: float = C.AVG_WINDOW_SECONDS):
        self.window_s = window_s
        self._buf: dict[int, deque] = {}   # ch -> deque of (t, wave float64)
        self._sum: dict[int, np.ndarray] = {}
        self._lock = threading.Lock()

    def add(self, ch: int, wave: np.ndarray, t: float | None = None):
        t = time.monotonic() if t is None else t
        w = wave.astype(np.float64)
        with self._lock:
            buf = self._buf.get(ch)
            if buf is None:
                buf = deque()
                self._buf[ch] = buf
                self._sum[ch] = np.zeros_like(w)
            buf.append((t, w))
            self._sum[ch] += w
            cutoff = t - self.window_s
            while buf and buf[0][0] < cutoff:
                self._sum[ch] -= buf.popleft()[1]

    def snapshot(self, ch: int):
        """Return (mean_wave float32, count) or (None, 0)."""
        with self._lock:
            buf = self._buf.get(ch)
            if not buf:
                return None, 0
            # evict stale even if no new events arrived
            cutoff = time.monotonic() - self.window_s
            while buf and buf[0][0] < cutoff:
                self._sum[ch] -= buf.popleft()[1]
            if not buf:
                return None, 0
            return (self._sum[ch] / len(buf)).astype(np.float32), len(buf)


class TriggerRateMeter:
    """Fixed rolling window of trigger rate for the Steam-style strip. snapshot()
    always returns the same-width window (x = seconds ago, negative..0)."""

    def __init__(self, bin_s: float = C.RATE_BIN_SECONDS,
                 window_s: float = C.RATE_WINDOW_SECONDS):
        self.bin_s = bin_s
        self.nbins = max(2, int(round(window_s / bin_s)))
        self._bins = deque([0] * self.nbins, maxlen=self.nbins)  # counts, oldest..newest
        self._cur_start = time.monotonic()
        self._total = 0
        self._lock = threading.Lock()

    def _roll(self):
        now = time.monotonic()
        while now - self._cur_start >= self.bin_s:
            self._cur_start += self.bin_s
            self._bins.append(0)  # push completed current bin forward; start fresh

    def add(self, n: int = 1):
        with self._lock:
            self._roll()
            self._bins[-1] += n
            self._total += n

    def snapshot(self):
        with self._lock:
            self._roll()
            counts = list(self._bins)
            rate = [c / self.bin_s for c in counts]
            # x axis: seconds ago for each bin (oldest .. newest ~ 0)
            t = [-(self.nbins - 1 - i) * self.bin_s for i in range(self.nbins)]
            recent = rate[-1] if rate else 0.0
            return {
                "bin_seconds": self.bin_s,
                "window_seconds": self.nbins * self.bin_s,
                "t": t,
                "rate": rate,
                "instant": recent,
                "total": self._total,
            }
