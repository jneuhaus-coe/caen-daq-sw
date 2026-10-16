"""What a folder of runs holds, as Quick Look sees it. Read-only.

Quick Look opens an EXPERIMENT: <data>/<experiment>/run_<NNN>[_<label>]/,
each run folder holding its run_<N>.root (or WaveDump files) and its own
run_metadata.json. Two older layouts still open, because Quick Look is for
data already on disk: a flat folder of several run_<N>.root sharing one
sidecar with a per-run "runs" map (the campaign folder, and anything copied
in from elsewhere), and a single-run folder straight under the data
directory (one ROOT file, possibly the number-less waveforms.root).
"""
from __future__ import annotations

import json
import os
import re

from .. import runs as runs_mod

_ROOT_FILE = re.compile(r"^(?:run_(\d+)|waveforms)\.root$", re.IGNORECASE)
_WAVEDUMP = re.compile(r"^wave_\d+\.(?:txt|dat)$", re.IGNORECASE)
_RUN_DIR = re.compile(r"^run_(\d+)(?:_(.*))?$")


def resolve(folder: str) -> str | None:
    """An experiment (or legacy run folder) under the data directory, or an
    absolute path anywhere.

    Absolute paths are allowed on purpose - Quick Look should open a folder
    copied in from elsewhere - and are safe because nothing here writes."""
    if not folder:
        return None
    if os.path.isabs(folder):
        p = os.path.abspath(folder)
        return p if os.path.isdir(p) else None
    return runs_mod.experiment_path_of(folder) or runs_mod.path_of(folder)


def _meta(path: str) -> dict:
    try:
        with open(os.path.join(path, "run_metadata.json")) as f:
            m = json.load(f)
        return m if isinstance(m, dict) else {}
    except (OSError, ValueError):
        return {}


def _listdir(path: str) -> list[str]:
    try:
        return os.listdir(path)
    except OSError:
        return []


def _run_dirs(path: str) -> list[tuple[int, str]]:
    """(number, folder name) for each run folder in an experiment."""
    out = []
    for n in _listdir(path):
        m = _RUN_DIR.match(n)
        if m and os.path.isdir(os.path.join(path, n)):
            out.append((int(m.group(1)), n))
    return sorted(out)


def _count(path: str) -> tuple[int, bool]:
    """(ROOT runs, any WaveDump data) in a folder of either layout."""
    names = _listdir(path)
    n_root = sum(1 for n in names if _ROOT_FILE.match(n))
    wavedump = any(_WAVEDUMP.match(n) for n in names)
    for _, d in _run_dirs(path):
        inner = _listdir(os.path.join(path, d))
        n_root += any(_ROOT_FILE.match(n) for n in inner)
        wavedump = wavedump or any(_WAVEDUMP.match(n) for n in inner)
    return n_root, wavedump


# Folders outside the data directory to list anyway, by absolute path: the
# fake backend's synthetic experiment lives in the state directory so it
# never touches real run numbering or the Runs panel.
EXTRA: list[tuple[str, str]] = []          # (absolute path, label)


def listing() -> list[dict]:
    """Every folder in the data directory that holds runs, newest first."""
    out = []
    for path, label in EXTRA:
        if os.path.isdir(path):
            n, _ = _count(path)
            out.append({"id": path, "label": label, "runs": n, "wavedump": False,
                        "started": 0})
    try:
        entries = [e for e in os.scandir(runs_mod.DATA_ROOT)
                   if e.is_dir() and not e.name.startswith(".")]
    except OSError:
        entries = []
    for e in entries:
        n_root, wavedump = _count(e.path)
        if not n_root and not wavedump:
            continue
        # Newest run's start, so the experiment being worked on sorts first.
        starts = [_meta(os.path.join(e.path, d)).get("started")
                  for _, d in _run_dirs(e.path)] + [_meta(e.path).get("started")]
        started = max((s for s in starts if isinstance(s, (int, float))),
                      default=os.path.getmtime(e.path))
        out.append({"id": e.name, "label": e.name, "runs": n_root,
                    "wavedump": wavedump, "started": started})
    extra = [r for r in out if r["started"] == 0]
    real = sorted((r for r in out if r["started"] != 0),
                  key=lambda r: (r["started"], r["id"]), reverse=True)
    return real + extra


def _conditions(items) -> dict:
    out = {}
    for it in items or []:
        if isinstance(it, dict) and str(it.get("key", "")).strip():
            out[str(it["key"]).strip()] = str(it.get("value", ""))
    return out


def _size(fp: str) -> int:
    try:
        return os.stat(fp).st_size
    except OSError:
        return 0


def _wavedump_entry(key: str, name: str, meta: dict) -> dict:
    return {"key": key, "file": None, "name": name,
            "number": meta.get("run_number"),
            "note": str(meta.get("note") or ""), "experiment": {},
            "events": meta.get("events"), "started": meta.get("started"),
            "bytes": 0, "state": "unsupported",
            "reason": "Not supported: WaveDump format"}


def _entry(path: str, rel: str, name: str, number, meta: dict,
           recording: bool) -> dict:
    state, reason = "ok", ""
    if recording and meta.get("events") is None:
        state, reason = "recording", "Recording - available when it ends"
    elif meta.get("events") is None and meta.get("started") is not None:
        state, reason = "unfinished", "Never closed - may not open"
    return {"key": rel, "file": rel, "name": name, "number": number,
            "note": str(meta.get("note") or ""),
            "experiment": _conditions(meta.get("experiment")),
            "events": meta.get("events"), "started": meta.get("started"),
            "bytes": _size(os.path.join(path, rel)),
            "state": state, "reason": reason}


def _same(a: str | None, b: str) -> bool:
    return a is not None and os.path.abspath(a) == os.path.abspath(b)


def describe(path: str, recording_folder: str | None = None) -> dict:
    """The runs in one folder, each with what the tags are built from.

    `recording_folder` is the run folder being recorded into right now, if
    any: its run is listed but not analysable until it ends. Each run's
    `name` is its folder name (run_002_10GeV-electrons) - the text a tag
    can be read from when the label carries what changes."""
    runs = []
    for number, d in _run_dirs(path):
        rd = os.path.join(path, d)
        meta = _meta(rd)
        inner = sorted(_listdir(rd))
        roots = [n for n in inner if _ROOT_FILE.match(n)]
        if roots:
            runs.append(_entry(path, f"{d}/{roots[0]}", d, number, meta,
                               _same(recording_folder, rd)))
        elif any(_WAVEDUMP.match(n) for n in inner):
            runs.append(_wavedump_entry(d, d, meta))

    # A flat folder: run_<N>.root files beside one sidecar (the old campaign
    # layout), or a legacy single-run folder.
    meta = _meta(path)
    per_run = meta.get("runs") if isinstance(meta.get("runs"), dict) else {}
    names = sorted(_listdir(path))
    root_files = [(n, m) for n in names if (m := _ROOT_FILE.match(n))]
    # By run number, not by name: run_10 after run_9, not after run_1.
    root_files.sort(key=lambda nm: (nm[1].group(1) is None,
                                    int(nm[1].group(1) or 0), nm[0]))
    single = len(root_files) == 1
    for name, m in root_files:
        number = int(m.group(1)) if m.group(1) else None
        entry = per_run.get(str(number)) if number is not None else None
        if entry is None and single:
            entry = meta                 # the top level describes the one run
        runs.append(_entry(path, name, name, number, entry or {},
                           _same(recording_folder, path)))
    if any(_WAVEDUMP.match(n) for n in names):
        runs.append(_wavedump_entry("wavedump", os.path.basename(path), meta))

    # Channel names: the newest run's, else the folder's own sidecar.
    chans = {}
    for _, d in reversed(_run_dirs(path)):
        c = _meta(os.path.join(path, d)).get("channels")
        if isinstance(c, dict) and c:
            chans = c
            break
    if not chans and isinstance(meta.get("channels"), dict):
        chans = meta["channels"]
    names_by_ch = {str(k): str((v or {}).get("name") or "") for k, v in chans.items()}
    return {"folder": os.path.basename(path.rstrip(os.sep)), "path": path,
            "runs": runs, "channel_names": names_by_ch,
            "has_metadata": bool(meta) or bool(_run_dirs(path))}
