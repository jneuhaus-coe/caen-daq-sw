"""Stage 2: from per-event tables to the numbers a plot shows.

Fast - it only touches the small stage-1 tables - so the channel map,
polarity, cuts, grouping and statistics can all change instantly. The UI
resolves tags and groups runs itself (tags are its own, read-only view of
the folder); this module just pools each group's events and reduces them.
"""
from __future__ import annotations

import math

import numpy as np

from . import features as F
from . import slots as S

N_CH = 16
QUANTITIES = ("charge", "amplitude", "time", "pedestal", "noise")
UNITS = {"charge": "pC", "amplitude": "mV", "time": "ns",
         "pedestal": "mV", "noise": "mV"}


# ---------- the channel map ----------
def channel_map(channels) -> list[int | None]:
    """16 logical channels -> ROOT slot, None when off or struck."""
    out: list[int | None] = []
    for i in range(N_CH):
        c = channels[i] if isinstance(channels, list) and i < len(channels) else None
        c = c if isinstance(c, dict) else {}
        if c.get("struck"):
            out.append(None)
            continue
        src = c.get("source") or f"in:{i}"
        out.append(S.parse_source(src))
    return out


def resolve_polarity(tables, cmap, mode: str) -> list[str]:
    """"neg"/"pos" per logical channel. Auto picks, per channel, whichever
    excursion is larger on average across every run in the request - one
    decision for the whole plot, so pooled runs never mix signs."""
    if mode in ("negative", "positive"):
        return ["neg" if mode == "negative" else "pos"] * N_CH
    out = []
    for slot in cmap:
        if slot is None:
            out.append("neg")
            continue
        score = 0.0
        for t in tables:
            with np.errstate(all="ignore"):
                hi = np.nanmean(np.asarray(t[F.VMAX][:, slot]))
                lo = np.nanmean(np.asarray(t[F.VMIN][:, slot]))
            if np.isfinite(hi) and np.isfinite(lo):
                score += (-lo) - hi
        out.append("neg" if score >= 0 else "pos")
    return out


def _slot_polarity(tables, slot: int) -> str:
    return resolve_polarity(tables, [slot], "auto")[0]


# ---------- per-event values ----------
class RunView:
    """One run's per-event values in logical channels and chosen polarity."""

    def __init__(self, table, cmap, pol, ref_slot, ref_pol):
        n = table.shape[1]
        self.n = n
        self.cmap = cmap
        self._t = table
        self._pol = pol
        self._ref = ref_slot
        self._ref_pol = ref_pol
        self._cache: dict = {}
        self.used = [i for i, s in enumerate(cmap) if s is not None]

    def _field(self, f: int) -> np.ndarray:
        if f not in self._cache:
            self._cache[f] = np.asarray(self._t[f], dtype=np.float32)
        return self._cache[f]

    def tref(self) -> np.ndarray | None:
        if self._ref is None:
            return None
        f = F.CFDN if self._ref_pol == "neg" else F.CFDP
        return self._field(f)[:, self._ref]

    def values(self, quantity: str, ch) -> np.ndarray:
        """Per-event values of `quantity` on logical channel `ch` (or "sum"
        for charge summed over every channel in use). NaN where undefined."""
        n = self.n
        if ch == "sum":
            if quantity != "charge":
                return np.full(n, np.nan, dtype=np.float32)
            tot = np.zeros(n, dtype=np.float64)
            for i in self.used:
                v = self.values("charge", i)
                tot += np.nan_to_num(v)
            return tot.astype(np.float32)
        try:
            ch = int(ch)
        except (TypeError, ValueError):
            return np.full(n, np.nan, dtype=np.float32)
        slot = self.cmap[ch] if 0 <= ch < N_CH else None
        if slot is None:
            return np.full(n, np.nan, dtype=np.float32)
        neg = self._pol[ch] == "neg"
        if quantity == "charge":
            q = self._field(F.Q)[:, slot]
            return -q if neg else q
        if quantity == "amplitude":
            return -self._field(F.VMIN)[:, slot] if neg else self._field(F.VMAX)[:, slot]
        if quantity == "time":
            t = self._field(F.CFDN if neg else F.CFDP)[:, slot]
            r = self.tref()
            return t - r if r is not None else t
        if quantity == "pedestal":
            return self._field(F.PED)[:, slot]
        if quantity == "noise":
            return self._field(F.RMS)[:, slot]
        return np.full(n, np.nan, dtype=np.float32)

    def clipped_any(self) -> np.ndarray:
        c = self._field(F.CLIP)
        if not self.used:
            return np.zeros(self.n, dtype=bool)
        return np.nan_to_num(c[:, [self.cmap[i] for i in self.used]]).any(1)

    def mask(self, cuts, no_clip: bool) -> np.ndarray:
        m = np.ones(self.n, dtype=bool)
        if no_clip:
            m &= ~self.clipped_any()
        for c in cuts or []:
            if not isinstance(c, dict):
                continue
            v = self.values(str(c.get("quantity")), c.get("channel"))
            with np.errstate(invalid="ignore"):
                if c.get("min") is not None:
                    m &= v >= float(c["min"])
                if c.get("max") is not None:
                    m &= v <= float(c["max"])
        return m


# ---------- statistics ----------
def stats(v: np.ndarray) -> dict:
    v = v[np.isfinite(v)]
    n = int(v.size)
    if n == 0:
        return {"n": 0, "mean": None, "median": None, "rms": None,
                "core_mean": None, "core_sigma": None}
    mean = float(v.mean())
    rms = float(v.std(ddof=1)) if n > 1 else 0.0
    # A Gaussian core without a fitter: iterate a 2-sigma window. Close to a
    # fit's sigma for a peak on tails, and honest about being quick.
    cm, cs = mean, rms
    for _ in range(4):
        if cs <= 0:
            break
        w = v[np.abs(v - cm) <= 2 * cs]
        if w.size < 5:
            break
        cm, cs = float(w.mean()), float(w.std(ddof=1))
    # A +/-2 sigma window cuts a Gaussian's sigma to 0.88 of itself; undo it.
    return {"n": n, "mean": mean, "median": float(np.median(v)), "rms": rms,
            "core_mean": cm, "core_sigma": cs / 0.8796 if cs else cs}


def reduce(v: np.ndarray, stat: str, err: str) -> tuple:
    """(y, error bar, n) for one pooled sample."""
    s = stats(v)
    n = s["n"]
    if n == 0:
        return None, None, 0
    rms, mean = s["rms"], s["mean"]
    if stat == "median":
        y = s["median"]
        e = rms if err == "rms" else 1.2533 * rms / math.sqrt(n)
    elif stat == "sigma":
        y = s["core_sigma"]
        e = y / math.sqrt(2 * n) if y else 0.0
    elif stat == "resolution":
        if not mean:
            return None, None, n
        y = s["core_sigma"] / abs(s["core_mean"]) if s["core_mean"] else None
        e = y / math.sqrt(2 * n) if y else None
    else:
        y = mean
        e = rms if err == "rms" else rms / math.sqrt(n)
    if err == "none":
        e = None
    return y, e, n


def fit_resolution(points) -> dict | None:
    """sigma/E = a/sqrt(E) (+) b (+) c/E, in quadrature: linear least squares
    on (sigma/E)^2 = a^2/E + b^2 + c^2/E^2. Terms that come out negative
    are dropped and the rest refit - a quick look, not a fit you publish."""
    pts = [(x, y) for x, y in points if x and x > 0 and y is not None]
    if len(pts) < 2:
        return None
    x = np.array([p[0] for p in pts], dtype=float)
    y2 = np.array([p[1] for p in pts], dtype=float) ** 2
    cols = {"a": 1 / x, "b": np.ones_like(x), "c": 1 / x ** 2}
    keep = ["a", "b", "c"][:min(3, len(pts))]
    for _ in range(3):
        A = np.stack([cols[k] for k in keep], 1)
        coef, *_ = np.linalg.lstsq(A, y2, rcond=None)
        neg = [k for k, c in zip(keep, coef) if c < 0]
        if not neg or len(keep) == 1:
            break
        keep = [k for k in keep if k not in neg]
    out = {k: 0.0 for k in ("a", "b", "c")}
    for k, c in zip(keep, coef):
        out[k] = float(math.sqrt(max(c, 0.0)))
    xs = np.geomspace(x.min(), x.max(), 40)
    ys = np.sqrt(out["a"] ** 2 / xs + out["b"] ** 2 + out["c"] ** 2 / xs ** 2)
    out["curve"] = [[float(a), float(b)] for a, b in zip(xs, ys)]
    return out


def decimate_trace(t, v, n: int = 512):
    k = max(1, len(t) // n)
    return [round(float(a), 3) for a in t[::k]], [round(float(b), 3) for b in v[::k]]


def cfd_on_average(t, v, frac: float, neg: bool):
    """A rough reference t0 on an average pulse, for drawing only."""
    x = -v if neg else v
    i = int(np.argmax(x[F.EDGE:-F.EDGE])) + F.EDGE
    a = x[i]
    if not a > 0:
        return None
    below = np.nonzero(x[:i] < frac * a)[0]
    if below.size == 0:
        return None
    j = int(below[-1])
    if x[j + 1] == x[j]:
        return float(t[j])
    return float(t[j] + (frac * a - x[j]) * (t[j + 1] - t[j]) / (x[j + 1] - x[j]))
