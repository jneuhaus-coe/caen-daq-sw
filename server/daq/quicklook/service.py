"""One Quick Look request, end to end: which runs, what stage 1 has for
each, and the plot stage 2 makes of it. Everything the UI sends is
validated here; nothing in a request can write anywhere."""
from __future__ import annotations

import os

import numpy as np

from . import aggregate as A
from . import features as F
from . import folder as FD
from . import slots as S

KINDS = ("channel", "facet", "hist", "spatial", "waveform")
STATS = ("mean", "median", "sigma", "resolution")
ERRS = ("rms", "sem", "none")


def _f(v, default=None):
    try:
        x = float(v)
        return x if np.isfinite(x) else default
    except (TypeError, ValueError):
        return default


def _chan(v):
    if v == "sum":
        return "sum"
    try:
        c = int(v)
        return c if 0 <= c < A.N_CH else 0
    except (TypeError, ValueError):
        return 0


def analyse(ql, req: dict, recording_folder=None) -> dict:
    path = FD.resolve(str(req.get("folder") or ""))
    if path is None:
        return {"ok": False, "error": "No such folder"}
    info = FD.describe(path, recording_folder)
    by_key = {r["key"]: r for r in info["runs"]}
    proc = F.normalize(req.get("processing"))
    cmap = A.channel_map(req.get("channels"))
    plot = req.get("plot") if isinstance(req.get("plot"), dict) else {}
    kind = plot.get("kind") if plot.get("kind") in KINDS else "channel"
    quantity = plot.get("quantity") if plot.get("quantity") in A.QUANTITIES else "charge"
    stat = plot.get("stat") if plot.get("stat") in STATS else "mean"
    err = plot.get("err") if plot.get("err") in ERRS else "rms"
    pchan = _chan(plot.get("channel", 0))
    cuts = req.get("cuts") if isinstance(req.get("cuts"), list) else []
    no_clip = bool(req.get("no_clip", True))

    groups = []
    for g in req.get("groups") or []:
        if not isinstance(g, dict):
            continue
        keys = [k for k in (g.get("runs") or []) if k in by_key
                and by_key[k]["state"] in ("ok", "unfinished")]
        groups.append({"series": str(g.get("series", "")), "x": _f(g.get("x")),
                       "runs": keys})
    wanted = sorted({k for g in groups for k in g["runs"]}
                    | {k for k in (req.get("runs") or []) if k in by_key
                       and by_key[k]["state"] in ("ok", "unfinished")})

    # Stage 1, whatever is ready.
    have: dict[str, dict] = {}
    for k in wanted:
        fp = os.path.join(path, by_key[k]["file"])
        try:
            have[k] = ql.table_for(fp, proc)
        except OSError as e:
            have[k] = {"state": "error", "table": None, "frac": 0.0, "error": str(e)}
    tables = {k: h["table"] for k, h in have.items() if h["table"] is not None}

    pol = A.resolve_polarity(list(tables.values()), cmap,
                             str(req.get("polarity") or "auto"))
    ref_slot = S.parse_source(req.get("timing_ref"))
    ref_pol = (A._slot_polarity(list(tables.values()), ref_slot)
               if ref_slot is not None and tables else "neg")
    views = {k: A.RunView(t, cmap, pol, ref_slot, ref_pol) for k, t in tables.items()}
    masks = {k: v.mask(cuts, no_clip) for k, v in views.items()}

    # Per-run summary and health.
    runs_out = {}
    peds = {}
    for k in wanted:
        h = have[k]
        r = {"state": h["state"], "frac": round(float(h.get("frac") or 0.0), 3),
             "error": h.get("error"), "events": h.get("events")}
        v = views.get(k)
        if v is not None:
            r["passed"] = int(masks[k].sum())
            r["clip_frac"] = round(float(v.clipped_any().mean()) if v.n else 0.0, 4)
            if proc["baseline"] is not None:      # no baseline, no pedestal to compare
                with np.errstate(all="ignore"):
                    peds[k] = [float(np.nanmean(v.values("pedestal", i))) if cmap[i] is not None
                               else None for i in range(A.N_CH)]
        runs_out[k] = r
    if len(peds) >= 2:
        for i in range(A.N_CH):
            col = [p[i] for p in peds.values() if p[i] is not None and np.isfinite(p[i])]
            if len(col) < 2:
                continue
            med = float(np.median(col))
            for k, p in peds.items():
                if p[i] is None or not np.isfinite(p[i]):
                    continue
                d = p[i] - med
                cur = runs_out[k].get("ped_shift")
                if abs(d) >= 3.0 and (cur is None or abs(d) > abs(cur["mv"])):
                    runs_out[k]["ped_shift"] = {"channel": i, "mv": round(d, 1)}

    def pooled(keys, q, ch):
        parts = [views[k].values(q, ch)[masks[k]] for k in keys if k in views]
        return np.concatenate(parts) if parts else np.empty(0, np.float32)

    out_plot: dict = {"kind": kind, "quantity": quantity, "unit": A.UNITS[quantity],
                      "stat": stat, "err": err, "series": []}
    if kind == "channel":
        for g in groups:
            pts = []
            for ch in range(A.N_CH):
                if cmap[ch] is None:
                    pts.append({"x": ch, "y": None, "off": True})
                    continue
                y, e, n = A.reduce(pooled(g["runs"], quantity, ch), stat, err)
                per = {k: A.reduce(pooled([k], quantity, ch), stat, "none")[0]
                       for k in g["runs"] if k in views}
                pts.append({"x": ch, "y": y, "err": e, "n": n, "per_run": per})
            out_plot["series"].append({"name": g["series"], "runs": g["runs"],
                                       "points": pts})
    elif kind == "facet":
        by_series: dict[str, list] = {}
        for g in groups:
            y, e, n = A.reduce(pooled(g["runs"], quantity, pchan), stat, err)
            by_series.setdefault(g["series"], []).append(
                {"x": g["x"], "y": y, "err": e, "n": n, "runs": g["runs"]})
        for name, pts in by_series.items():
            pts.sort(key=lambda p: (p["x"] is None, p["x"] or 0))
            s = {"name": name, "points": pts}
            if stat == "resolution" and plot.get("fit"):
                s["fit"] = A.fit_resolution([(p["x"], p["y"]) for p in pts])
            out_plot["series"].append(s)
        out_plot["channel"] = pchan
    elif kind == "hist":
        samples = [pooled(g["runs"], quantity, pchan) for g in groups]
        allv = np.concatenate([s[np.isfinite(s)] for s in samples]) if samples else np.empty(0)
        lo_hi = plot.get("range") if isinstance(plot.get("range"), list) else None
        if lo_hi and len(lo_hi) == 2 and _f(lo_hi[0]) is not None and _f(lo_hi[1]) is not None:
            lo, hi = sorted((_f(lo_hi[0]), _f(lo_hi[1])))
        elif allv.size:
            lo, hi = (float(x) for x in np.percentile(allv, [0.5, 99.5]))
        else:
            lo, hi = 0.0, 1.0
        if hi <= lo:
            hi = lo + 1.0
        bins = int(min(max(_f(plot.get("bins"), 60) or 60, 10), 200))
        edges = np.linspace(lo, hi, bins + 1)
        for g, s in zip(groups, samples):
            c, _ = np.histogram(s[np.isfinite(s)], edges)
            out_plot["series"].append({"name": g["series"], "counts": c.tolist(),
                                       "stats": A.stats(s), "runs": g["runs"]})
        out_plot["edges"] = [float(e) for e in edges]
        out_plot["channel"] = pchan
    elif kind == "spatial":
        rows = int(min(max(_f(plot.get("rows"), 4) or 4, 1), 8))
        cols = int(min(max(_f(plot.get("cols"), 4) or 4, 1), 8))
        pitch = _f(plot.get("pitch"), 1.0) or 1.0
        pix = plot.get("pixels") if isinstance(plot.get("pixels"), list) else []
        cells = []
        for i in range(rows * cols):
            ch = pix[i] if i < len(pix) else -1
            try:
                ch = int(ch)
            except (TypeError, ValueError):
                ch = -1
            cells.append(ch if 0 <= ch < A.N_CH else -1)
        pos = {}
        for i, ch in enumerate(cells):
            if ch >= 0 and cmap[ch] is not None:
                r, c = divmod(i, cols)
                pos[ch] = ((c - (cols - 1) / 2) * pitch, ((rows - 1) / 2 - r) * pitch)
        xs = np.array([pos[ch][0] for ch in pos])
        ys = np.array([pos[ch][1] for ch in pos])
        for g in groups:
            qs = {ch: pooled(g["runs"], "charge", ch) for ch in pos}
            if not qs:
                out_plot["series"].append({"name": g["series"], "cells": [], "centroid": None})
                continue
            Q = np.stack([np.nan_to_num(qs[ch]) for ch in pos], 1)
            mean_tot = float(np.mean(Q.sum(1))) if Q.size else 0.0
            share = {ch: (float(np.mean(qs[ch][np.isfinite(qs[ch])])) / mean_tot
                          if mean_tot else None) for ch in pos}
            # The centroid of the map as drawn: each pixel weighted by its
            # share, so the dot and the cells can never disagree. A negative
            # share (a baseline or window problem, flagged on the cell) adds
            # no weight rather than pushing the centroid away.
            w = np.array([max(share[ch] or 0.0, 0.0) for ch in pos])
            cent = None
            if w.sum() > 0:
                cx, cy = float(w @ xs / w.sum()), float(w @ ys / w.sum())
                # Spread: how far single events' centroids scatter around it.
                Qp = np.clip(Q, 0, None)
                tot = Qp.sum(1)
                ok = tot > 0
                ex, ey = (Qp[ok] @ xs) / tot[ok], (Qp[ok] @ ys) / tot[ok]
                cent = {"x": cx, "y": cy, "n": int(ok.sum()),
                        "sx": float(np.sqrt(np.mean((ex - cx) ** 2))) if ok.any() else 0.0,
                        "sy": float(np.sqrt(np.mean((ey - cy) ** 2))) if ok.any() else 0.0}
            out_plot["series"].append({
                "name": g["series"], "runs": g["runs"], "centroid": cent,
                "cells": [{"channel": ch, "share": share.get(ch) if ch >= 0 else None}
                          for ch in cells]})
        out_plot.update(rows=rows, cols=cols, pitch=pitch)
    elif kind == "waveform":
        # Struck channels too, read from their source: the windows are set
        # on these pulses, and a struck one is shown, masked "excluded".
        smap = A.channel_map([{**c, "struck": False} if isinstance(c, dict) else c
                              for c in (req.get("channels") or [])])
        chans = _chans(plot.get("channels"), smap)
        out_plot["channels"] = chans
        for g in groups:
            out_plot["series"].append({
                "name": g["series"], "runs": g["runs"],
                "traces": _averages(ql, path, by_key, g["runs"],
                                    {ch: smap[ch] for ch in chans},
                                    proc["baseline"], len(chans))})

    # Where a reference-placed window sat, for drawing it: per series, the
    # median over its selected events of the reference time each event's
    # window was placed from. Series whose pulses start at different times
    # get windows at different times - one window for all would fit none.
    ref_t0: dict = {}
    if proc["window"]["mode"] == "reference":
        by_series: dict[str, list] = {}
        for g in groups:
            by_series.setdefault(g["series"], []).extend(g["runs"])
        for name, keys in by_series.items():
            parts = [views[k].window_ref()[masks[k]] for k in dict.fromkeys(keys) if k in views]
            v = np.concatenate(parts) if parts else np.empty(0)
            v = v[np.isfinite(v)]
            ref_t0[name] = float(np.median(v)) if v.size else None

    total = len(wanted)
    full = sum(1 for k in wanted if have[k]["state"] == "full")
    prev = sum(1 for k in wanted if have[k]["state"] == "preview")
    errs = sum(1 for k in wanted if have[k]["state"] == "error")
    frac = (sum(1.0 if have[k]["state"] == "full" else float(have[k].get("frac") or 0)
                for k in wanted) / total) if total else 1.0
    events = sum(v.n for v in views.values())
    passed = sum(int(m.sum()) for m in masks.values())
    return _clean({"ok": True, "folder": info["folder"],
            "progress": {"total": total, "full": full, "preview": prev,
                         "errors": errs, "frac": round(frac, 3),
                         "done": full + errs == total},
            "runs": runs_out, "polarity": pol, "events": events, "passed": passed,
            "plot": out_plot, "ref_t0": ref_t0,
            "processing": {**proc, "window": {**proc["window"],
                           "reference": _src_name(proc["window"]["reference"])}}})


def _clean(o):
    """NaN/inf -> None all the way down: JSON has no NaN, and a browser's
    JSON.parse rejects the whole response over one."""
    if isinstance(o, float):
        return o if np.isfinite(o) else None
    if isinstance(o, (np.floating,)):
        return float(o) if np.isfinite(o) else None
    if isinstance(o, (np.integer,)):
        return int(o)
    if isinstance(o, dict):
        return {k: _clean(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)):
        return [_clean(v) for v in o]
    return o


def _src_name(slot):
    if slot is None:
        return None
    if slot in S.TR0_SLOTS:
        return f"tr0:{S.TR0_SLOTS.index(slot)}"
    g, i = divmod(slot, 9)
    return f"in:{g * 8 + i}"


def _chans(v, cmap) -> list[int]:
    """Logical channels a request names, minus any that are off or struck."""
    out = []
    for c in v if isinstance(v, list) else []:
        ch = _chan(c)
        if isinstance(ch, int) and cmap[ch] is not None and ch not in out:
            out.append(ch)
    return out


def _averages(ql, path, by_key, keys, slots: dict, baseline, n_panels: int) -> list:
    """Event-weighted average pulse of each slot over runs, in input mV:
    [{"channel", "t", "v", "events"}], one per entry of `slots` (logical
    channel -> ROOT slot). With a baseline window, it is subtracted so
    groups and channels overlay. Each run's average is read once."""
    if not slots:
        return []
    acc_x = acc_t = None
    n_tot = 0
    for k in keys:
        a = ql.avg_for(os.path.join(path, by_key[k]["file"]))
        if a is None:
            continue
        x, t, n = a
        acc_x = x * n if acc_x is None else acc_x + x * n
        acc_t = t * n if acc_t is None else acc_t + t * n
        n_tot += n
    if not n_tot:
        return []
    # Small multiples are a few hundred pixels wide: half the points do.
    points = 512 if n_panels <= 2 else 256
    out = []
    for ch, slot in slots.items():
        x = acc_x[slot] / n_tot
        t = acc_t[S.group_of_slot(slot)] / n_tot
        if baseline is not None:
            m = (t >= baseline[0]) & (t < baseline[1])
            if m.any():
                x = x - x[m].mean()
        tt, vv = A.decimate_trace(t, x, points)
        out.append({"channel": ch, "t": tt, "v": vv, "events": n_tot})
    return out
