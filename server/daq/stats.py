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


class _Bucket:
    __slots__ = ("t0", "t1", "n", "sum")

    def __init__(self, t: float, like: np.ndarray):
        self.t0 = self.t1 = t
        self.n = 0
        self.sum = np.zeros(like.shape, np.float64)


class RollingAverage:
    """Per-channel mean over a rolling window: the last `window_s` seconds of
    triggers ("time" - rate-independent), or the last `window_n` events
    ("events" - holds still when triggers stop).

    Events are summed into at most ~AVG_BUCKETS buckets per channel rather
    than kept one by one, so memory does not grow with the rate or the window:
    a 10 s window at 1 kHz once meant 10k stored waveforms per channel. The
    price is granularity - the window covers its nominal span plus at most
    one bucket (1/AVG_BUCKETS of it), and `count` reports exactly how many
    events are in it. Up to AVG_BUCKETS events, every event is its own bucket
    and the event window is exact."""

    MODES = ("time", "events")

    def __init__(self, window_s: float = C.AVG_WINDOW_SECONDS,
                 mode: str = "time", window_n: int = C.AVG_WINDOW_EVENTS):
        self.mode = mode if mode in self.MODES else "time"
        self.window_s = float(window_s)
        self.window_n = int(window_n)
        self._buf: dict[int, deque[_Bucket]] = {}
        self._sum: dict[int, np.ndarray] = {}
        self._n: dict[int, int] = {}
        self._lock = threading.Lock()

    def configure(self, mode: str, window_s: float, window_n: int) -> None:
        """Change the window. Starts it empty: buckets sized for the old
        window would misreport the new one."""
        with self._lock:
            self.mode = mode if mode in self.MODES else "time"
            self.window_s = min(max(float(window_s), C.AVG_SECONDS_MIN), C.AVG_SECONDS_MAX)
            self.window_n = min(max(int(window_n), 1), C.AVG_EVENTS_MAX)
            self._clear_locked()

    def settings(self) -> dict:
        return {"mode": self.mode, "seconds": self.window_s, "events": self.window_n}

    def _full(self, b: _Bucket, t: float) -> bool:
        if self.mode == "events":
            return b.n >= max(1, -(-self.window_n // C.AVG_BUCKETS))
        return t - b.t0 >= self.window_s / C.AVG_BUCKETS

    def _evict(self, ch: int, now: float) -> None:
        buf = self._buf[ch]
        if self.mode == "events":
            while len(buf) > 1 and self._n[ch] - buf[0].n >= self.window_n:
                self._drop(ch)
        else:
            cutoff = now - self.window_s
            while buf and buf[0].t1 < cutoff:
                self._drop(ch)

    def _drop(self, ch: int) -> None:
        b = self._buf[ch].popleft()
        self._sum[ch] -= b.sum
        self._n[ch] -= b.n

    def add(self, ch: int, wave: np.ndarray, t: float | None = None):
        t = time.monotonic() if t is None else t
        with self._lock:
            buf = self._buf.get(ch)
            if buf is None:
                buf = self._buf[ch] = deque()
                self._sum[ch] = np.zeros(wave.shape, np.float64)
                self._n[ch] = 0
            if not buf or self._full(buf[-1], t):
                buf.append(_Bucket(t, wave))
            b = buf[-1]
            b.sum += wave
            b.n += 1
            b.t1 = t
            self._sum[ch] += wave
            self._n[ch] += 1
            self._evict(ch, t)

    def _clear_locked(self) -> None:
        self._buf.clear()
        self._sum.clear()
        self._n.clear()

    def clear(self) -> None:
        """Forget every channel's window - at each arm, so an average never
        mixes events taken under two different DC offsets, and on request."""
        with self._lock:
            self._clear_locked()

    def snapshot(self, ch: int):
        """Return (mean_wave float32, count) or (None, 0)."""
        with self._lock:
            buf = self._buf.get(ch)
            if not buf:
                return None, 0
            # A time window empties by itself when triggers stop.
            self._evict(ch, time.monotonic())
            n = self._n[ch]
            if not buf or n <= 0:
                return None, 0
            return (self._sum[ch] / n).astype(np.float32), n


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

    def reset(self):
        """Zero the window and the running total. Called when acquisition starts
        so Count reflects this run, not the lifetime of the process."""
        with self._lock:
            self._bins = deque([0] * self.nbins, maxlen=self.nbins)
            self._cur_start = time.monotonic()
            self._total = 0

    def add(self, n: int = 1):
        with self._lock:
            self._roll()
            self._bins[-1] += n
            self._total += n

    def snapshot(self):
        with self._lock:
            self._roll()
            # Drop the bin still being filled: it always reads low, which made
            # the headline number disagree with the last bar on the strip.
            counts = list(self._bins)[:-1]
            rate = [c / self.bin_s for c in counts]
            n = len(rate)
            # x axis: seconds ago for each bin (oldest .. newest)
            t = [-(n - i) * self.bin_s for i in range(n)]
            recent = rate[-1] if rate else 0.0
            return {
                "bin_seconds": self.bin_s,
                "window_seconds": n * self.bin_s,
                "t": t,
                "rate": rate,
                "instant": recent,
                "total": self._total,
            }
