"""What a run folder holds, as Quick Look sees it. Read-only.

A folder is a campaign (several run_<N>.root) or a single run (one ROOT
file, possibly the number-less waveforms.root). The sidecar
run_metadata.json carries each run's note and experiment conditions under
"runs"; its top-level fields describe only the latest recording.
"""
from __future__ import annotations

import json
import os
import re

from .. import runs as runs_mod

_ROOT_FILE = re.compile(r"^(?:run_(\d+)|waveforms)\.root$", re.IGNORECASE)
_WAVEDUMP = re.compile(r"^wave_\d+\.(?:txt|dat)$", re.IGNORECASE)


def resolve(folder: str) -> str | None:
    """A folder name under the data directory, or an absolute path anywhere.

    Absolute paths are allowed on purpose - Quick Look should open a folder
    copied in from elsewhere - and are safe because nothing here writes."""
    if not folder:
        return None
    if os.path.isabs(folder):
        p = os.path.abspath(folder)
        return p if os.path.isdir(p) else None
    return runs_mod.path_of(folder)


def _meta(path: str) -> dict:
    try:
        with open(os.path.join(path, "run_metadata.json")) as f:
            m = json.load(f)
        return m if isinstance(m, dict) else {}
    except (OSError, ValueError):
        return {}


# Folders outside the data directory to list anyway, by absolute path: the
# fake backend's synthetic campaign lives in the state directory so it never
# touches real run numbering or the Runs panel.
EXTRA: list[tuple[str, str]] = []          # (absolute path, label)


def listing() -> list[dict]:
    """Every folder in the data directory that holds runs, newest first."""
    out = []
    for path, label in EXTRA:
        if os.path.isdir(path):
            n = sum(1 for x in os.listdir(path) if _ROOT_FILE.match(x))
            out.append({"id": path, "label": label, "runs": n, "wavedump": False,
                        "started": 0})
    root = runs_mod.DATA_ROOT
    try:
        entries = [e for e in os.scandir(root) if e.is_dir()]
    except OSError:
        return []
    for e in entries:
        try:
            names = os.listdir(e.path)
        except OSError:
            continue
        n_root = sum(1 for n in names if _ROOT_FILE.match(n))
        wavedump = any(_WAVEDUMP.match(n) for n in names)
        if not n_root and not wavedump:
            continue
        started = _meta(e.path).get("started") or os.path.getmtime(e.path)
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


def describe(path: str, recording_folder: str | None = None) -> dict:
    """The runs in one folder, each with what the tags are built from.

    `recording_folder` is the folder being recorded into right now, if any:
    its run without a final event count is the one being written, listed
    but not analysable until it ends."""
    meta = _meta(path)
    per_run = meta.get("runs") if isinstance(meta.get("runs"), dict) else {}
    names = sorted(os.listdir(path))
    runs = []
    root_files = [(n, _ROOT_FILE.match(n)) for n in names]
    root_files = [(n, m) for n, m in root_files if m]
    # By run number, not by name: run_10 after run_9, not after run_1.
    root_files.sort(key=lambda nm: (nm[1].group(1) is None,
                                    int(nm[1].group(1) or 0), nm[0]))
    single = len(root_files) == 1
    for name, m in root_files:
        number = int(m.group(1)) if m.group(1) else None
        entry = per_run.get(str(number)) if number is not None else None
        if entry is None and single:
            # A single-run folder from before the per-run record, or
            # waveforms.root: the top level describes it.
            entry = {"note": meta.get("note", ""), "events": meta.get("events"),
                     "experiment": meta.get("experiment", []),
                     "started": meta.get("started")}
        entry = entry or {}
        state, reason = "ok", ""
        rec = (recording_folder is not None
               and os.path.abspath(recording_folder) == os.path.abspath(path)
               and entry.get("events") is None)
        if rec:
            state, reason = "recording", "Recording - available when it ends"
        elif entry.get("events") is None and meta.get("output_format") == "root" \
                and number is not None and str(number) in per_run:
            state, reason = "unfinished", "Never closed - may not open"
        fp = os.path.join(path, name)
        try:
            st = os.stat(fp)
            size = st.st_size
        except OSError:
            size = 0
        runs.append({
            "key": name, "file": name, "number": number,
            "note": str(entry.get("note") or ""),
            "experiment": _conditions(entry.get("experiment")),
            "events": entry.get("events"),
            "started": entry.get("started"),
            "bytes": size, "state": state, "reason": reason,
        })
    if any(_WAVEDUMP.match(n) for n in names):
        runs.append({"key": "wavedump", "file": None, "number": meta.get("run_number"),
                     "note": str(meta.get("note") or ""), "experiment": {},
                     "events": meta.get("events"), "started": meta.get("started"),
                     "bytes": 0, "state": "unsupported",
                     "reason": "Not supported: WaveDump format"})
    chans = meta.get("channels") if isinstance(meta.get("channels"), dict) else {}
    names_by_ch = {str(k): str((v or {}).get("name") or "") for k, v in chans.items()}
    return {"folder": os.path.basename(path.rstrip(os.sep)), "path": path,
            "runs": runs, "channel_names": names_by_ch,
            "has_metadata": bool(meta)}
