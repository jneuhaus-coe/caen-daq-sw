"""Stage 1: one pass over a run's waveforms -> a per-event table per slot.

The table is independent of the channel map, polarity and cuts (all stage 2),
so changing those never rereads a waveform. It depends only on the
processing settings: the baseline window (or none), the integration window
(or the whole record), and the CFD fraction. Both polarities are kept (VMAX/VMIN, CFDP/CFDN) for the same
reason - choosing one is instant later.

Units: input mV (TR0 rescaled for its x2 attenuator), ns on each group's own
time axis (the file's `times`, true non-uniform axes in "timing" mode), and
charge in pC = mV*ns/50 ohm.
"""
from __future__ import annotations

import numpy as np

from . import slots as S

# Field order of the stored table, shape (N_FIELDS, events, 18).
# TREF is per event, not per slot (the reference's crossing that placed the
# window, NaN without a reference); every slot carries the same value.
PED, RMS, Q, VMAX, VMIN, TMAX, TMIN, CFDP, CFDN, CLIP, TREF = range(11)
N_FIELDS = 11
FIELD_NAMES = ("ped", "rms", "q", "vmax", "vmin", "tmax", "tmin",
               "cfdp", "cfdn", "clip", "tref")

OHMS = 50.0
EDGE = 2            # DRS4 edge cells misbehave even corrected: never used
STEP = 400          # events per chunk: (400,18,1024) float32 is ~30 MB
PREVIEW_EVENTS = 1000
# Part of every cache key: bump it whenever what a pass computes changes, so
# results from an older build are never mistaken for current ones.
VERSION = 3

_GROUP = np.array([S.group_of_slot(s) for s in range(S.N_SLOTS)])
_SCALE = np.array([S.scale_of_slot(s) for s in range(S.N_SLOTS)],
                  dtype=np.float32)


def normalize(proc: dict | None) -> dict:
    """The processing settings stage 1 depends on, in one canonical shape -
    the cache key is a hash of exactly this, so equal settings always hit."""
    p = proc or {}

    def rng(v, default):
        try:
            a, b = float(v[0]), float(v[1])
        except (TypeError, ValueError, IndexError):
            return list(default)
        return [min(a, b), max(a, b)]

    win = p.get("window") or {}
    mode = win.get("mode") if win.get("mode") in ("reference", "all") else "record"
    ref = S.parse_source(win.get("reference")) if mode == "reference" else None
    if mode == "reference" and ref is None:
        mode = "record"
    # An explicit null is "no baseline": slow signals have no quiet stretch
    # to take one from. A missing key is an old client: the default window.
    baseline = (None if "baseline" in p and p["baseline"] in (None, "none")
                else rng(p.get("baseline"), (10.0, 40.0)))
    try:
        cfd = float(p.get("cfd", 0.3))
    except (TypeError, ValueError):
        cfd = 0.3
    cfd = min(max(cfd, 0.05), 0.95)
    return {
        "version": VERSION,
        "baseline": baseline,
        "window": {"mode": mode,
                   "range": rng(win.get("range"),
                                (-5.0, 45.0) if mode == "reference" else (60.0, 120.0)),
                   "reference": ref},
        "cfd": round(cfd, 4),
    }


def _take(a, i):
    return np.take_along_axis(a, i[..., None], -1)[..., 0]


def _peak(v, mask):
    """Largest value of v inside mask, its index; NaN where mask is empty."""
    vm = np.where(mask, v, -np.inf)
    i = vm.argmax(-1)
    a = _take(v, i).astype(np.float32)
    a[~mask.any(-1)] = np.nan
    return a, i


def _cfd(v, t, mask, i_peak, amp, frac):
    """Constant-fraction time on the leading edge of a positive-going pulse:
    the last crossing of frac*amp before the peak, linearly interpolated on
    the sample times (the true axis when the file has one)."""
    n = v.shape[-1]
    thr = (frac * amp)[..., None]
    idx = np.arange(n)
    cond = (v < thr) & mask & (idx < i_peak[..., None])
    found = cond.any(-1)
    last = n - 1 - cond[..., ::-1].argmax(-1)
    j = np.clip(last, 0, n - 2)
    v0, v1 = _take(v, j), _take(v, j + 1)
    t0, t1 = _take(t, j), _take(t, j + 1)
    with np.errstate(invalid="ignore", divide="ignore"):
        out = t0 + (frac * amp - v0) * (t1 - t0) / (v1 - v0)
    out = out.astype(np.float32)
    out[~found | ~(amp > 0) | ~np.isfinite(out)] = np.nan
    return out


def chunk(ch_mv: np.ndarray, times: np.ndarray, proc: dict):
    """Features for one chunk. ch_mv (n,18,L) window-referenced mV as the
    file stores it; times (n,2,L) ns. Returns (table (F,n,18), sum of
    rescaled traces (18,L) for the average pulse)."""
    n, _, L = ch_mv.shape
    raw = ch_mv.astype(np.float32, copy=False)
    t = times[:, _GROUP, :].astype(np.float32, copy=False)        # (n,18,L)
    edge = np.zeros(L, dtype=bool)
    edge[EDGE:L - EDGE] = True

    clip = (np.abs(raw[..., edge]) >= S.CLIP_MV).any(-1)
    x = raw * _SCALE[None, :, None]

    if proc["baseline"] is None:
        # As recorded: nothing subtracted, so no pedestal or noise to report.
        v = x
        ped = rms = np.full((n, S.N_SLOTS), np.nan, dtype=np.float32)
    else:
        b0, b1 = proc["baseline"]
        bmask = (t >= b0) & (t < b1) & edge
        cnt = bmask.sum(-1)
        with np.errstate(invalid="ignore", divide="ignore"):
            ped = (np.where(bmask, x, 0.0).sum(-1) / cnt).astype(np.float32)
            v = x - ped[..., None]
            rms = np.sqrt(np.where(bmask, v * v, 0.0).sum(-1) / cnt).astype(np.float32)

    w0, w1 = proc["window"]["range"]
    tref_event = None
    ref = proc["window"]["reference"]
    if proc["window"]["mode"] == "reference" and ref is not None:
        vr = v[:, ref, :]
        tr = t[:, ref, :]
        m = np.broadcast_to(edge, vr.shape)
        hi, ihi = _peak(vr, m)
        lo, ilo = _peak(-vr, m)
        neg = np.nanmean(lo) > np.nanmean(hi) if n else False
        tref = (_cfd(-vr, tr, m, ilo, lo, proc["cfd"]) if neg
                else _cfd(vr, tr, m, ihi, hi, proc["cfd"]))
        tref_event = tref
        tref = tref[:, None, None]
        with np.errstate(invalid="ignore"):
            wmask = (t >= tref + w0) & (t < tref + w1) & edge
    elif proc["window"]["mode"] == "all":
        wmask = np.broadcast_to(edge, t.shape)
    else:
        wmask = (t >= w0) & (t < w1) & edge

    dt = np.empty_like(t)
    dt[..., :-1] = np.diff(t, axis=-1)
    dt[..., -1] = dt[..., -2]
    q = (np.where(wmask, v * dt, 0.0).sum(-1) / OHMS).astype(np.float32)
    q[~wmask.any(-1)] = np.nan

    vmax, imax = _peak(v, wmask)
    nmin, imin = _peak(-v, wmask)
    out = np.empty((N_FIELDS, n, S.N_SLOTS), dtype=np.float32)
    out[PED], out[RMS], out[Q] = ped, rms, q
    out[VMAX], out[VMIN] = vmax, -nmin
    out[TMAX], out[TMIN] = _take(t, imax), _take(t, imin)
    out[TMAX][np.isnan(vmax)] = np.nan
    out[TMIN][np.isnan(nmin)] = np.nan
    out[CFDP] = _cfd(v, t, wmask, imax, vmax, proc["cfd"])
    out[CFDN] = _cfd(-v, t, wmask, imin, nmin, proc["cfd"])
    out[CLIP] = clip
    out[TREF] = tref_event[:, None] if tref_event is not None else np.nan
    # The writer fills slots it had no samples for (a disabled bank, an event
    # without TR0) with exact zeros. Those are "not recorded", not 0 mV.
    absent = ~(raw != 0).any(-1)
    out[:, absent] = np.nan
    return out, x.sum(0, dtype=np.float64), times.sum(0, dtype=np.float64)


def run_pass(path: str, proc: dict, stop: int | None = None,
             progress=None, cancelled=None):
    """Features for a whole run (or its first `stop` events).

    Returns (table (F,N,18) float32, avg (18,L) input mV, avg times (2,L)).
    `progress(fraction)` is called per chunk; `cancelled()` returning True
    abandons the pass (returns None)."""
    import uproot

    with uproot.open(path) as f:
        tree = f["pulse"]
        total = tree.num_entries
        n = total if stop is None else min(total, stop)
        table = np.full((N_FIELDS, n, S.N_SLOTS), np.nan, dtype=np.float32)
        sum_x = sum_t = None
        done = 0
        if n == 0:
            return table, None, None
        for arrays in tree.iterate(["channel", "times"], step_size=STEP,
                                   entry_stop=n, library="np"):
            if cancelled is not None and cancelled():
                return None
            ch = np.asarray(arrays["channel"])
            tm = np.asarray(arrays["times"])
            k = ch.shape[0]
            feats, sx, st = chunk(ch, tm, proc)
            table[:, done:done + k, :] = feats
            sum_x = sx if sum_x is None else sum_x + sx
            sum_t = st if sum_t is None else sum_t + st
            done += k
            if progress is not None:
                progress(done / n)
    return (table, (sum_x / max(done, 1)).astype(np.float32),
            (sum_t / max(done, 1)).astype(np.float32))
