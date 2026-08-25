"""The x742 amplitude corrections and the true time axis, in numpy.

Port of CAEN's X742CorrectionRoutines.c (ships with WaveDump; also at
github.com/cjpl/caen-suite), for the "timing" correction mode: the amplitude
part - cell offsets, per-sample offsets, spike (peak) removal - is applied
exactly as the library would, but the routine STOPS where the library's time
correction begins. That step linearly resamples every waveform onto a uniform
grid, which smooths pulse edges; for ps-level timing the analysis wants the
samples untouched and the true, non-uniform time axis alongside instead. This
module produces exactly that pair.

Tables come off the board via CAEN_DGTZ_GetCorrectionTables - the same
constants the library and the offline converters use.

Faithfulness notes, both about PeakCorrection edge cases:
- at i == n-1 the C code can fall through to a branch that reads one sample
  past the end; this port treats the last sample's test as complete instead.
- C detects spikes on the array it is currently fixing; this port detects on
  a snapshot and then fixes, which differs only when two spikes fall within
  two cells of each other.
"""
from __future__ import annotations

import numpy as np

_SPIKE = 30.0          # counts; the threshold hard-wired in CAEN's routine


def amplitude_correct(waves: np.ndarray, cell: np.ndarray, nsample: np.ndarray,
                      start_cell: int) -> None:
    """In place, on one group's waveforms (rows = group-local channels, in
    group order, TR last when present; columns = samples).

    cell[ch] is indexed by physical DRS4 cell, so it rotates with the event's
    start cell; nsample[ch] is indexed by readout position, so it does not.
    """
    n = waves.shape[1]
    idx = (start_cell + np.arange(n)) % 1024
    for ci in range(waves.shape[0]):
        waves[ci] -= cell[ci][idx]
        waves[ci] -= nsample[ci][:n]
    peak_correct(waves)


def true_times(time_table: np.ndarray, start_cell: int, tsamp_ns: float,
               n: int = 1024) -> np.ndarray:
    """The event's actual sample times in ns, from the per-cell time stamps.

    Consecutive stamps rotated by the start cell; a non-positive difference
    is the wrap of the ring buffer and gains one full revolution, exactly as
    the reference does before it (unlike us) resamples.
    """
    rot = time_table[(start_cell + np.arange(n)) % 1024].astype(np.float64)
    d = np.diff(rot)
    d = np.where(d > 0, d, d + tsamp_ns * 1024)
    out = np.empty(n, dtype=np.float32)
    out[0] = 0.0
    out[1:] = np.cumsum(d)
    return out


def peak_correct(waves: np.ndarray) -> None:
    """Spike removal, in place. The DRS4's readout can leave one- to two-cell
    upward spikes simultaneously in all 8 channels of a group; a cell is fixed
    only when every one of the 8 shows the signature, so real (per-channel)
    pulses are never touched. TR (a 9th row, when present) is repaired along
    with the group but never votes.
    """
    n = waves.shape[1]
    if n < 4:
        return
    sig = waves[:8]

    # The reference starts by pinning sample 0 to sample 1, unconditionally.
    waves[:, 0] = waves[:, 1]

    # Detection on a snapshot (see module docstring), vectorized per index:
    # spike[ch, i] follows the reference's three regimes.
    w = sig.copy()
    spike = np.zeros((8, n), dtype=bool)
    spike[:, 1] = ((w[:, 2] - w[:, 1]) > _SPIKE) | \
                  (((w[:, 3] - w[:, 1]) > _SPIKE) & ((w[:, 3] - w[:, 2]) > _SPIKE))
    if n >= 5:
        i = np.arange(2, n - 2)
        spike[:, 2:n - 2] = ((w[:, i - 1] - w[:, i]) > _SPIKE) & \
                            (((w[:, i + 1] - w[:, i]) > _SPIKE) |
                             ((w[:, i + 2] - w[:, i]) > _SPIKE))
    spike[:, n - 2] = (w[:, n - 3] - w[:, n - 2]) > _SPIKE
    spike[:, n - 1] = (w[:, n - 2] - w[:, n - 1]) > _SPIKE

    for i in np.nonzero(spike.all(axis=0))[0]:
        for ch in range(waves.shape[0]):
            v = waves[ch]
            if i == 1:
                if (v[2] - v[1]) > _SPIKE:
                    v[0] = v[2]; v[1] = v[2]
                else:
                    v[0] = v[3]; v[1] = v[3]; v[2] = v[3]
            elif i == n - 1:
                v[n - 1] = v[n - 2]
            elif (v[i + 1] - v[i]) > _SPIKE:
                v[i] = (v[i + 1] + v[i - 1]) / 2
            elif i == n - 2:
                v[n - 2] = v[n - 3]; v[n - 1] = v[n - 3]
            else:
                v[i] = (v[i + 2] + v[i - 1]) / 2
                v[i + 1] = (v[i + 2] + v[i - 1]) / 2
