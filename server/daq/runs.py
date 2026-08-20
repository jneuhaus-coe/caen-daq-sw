"""Recorded runs on disk.

A run is a directory holding one wave file per channel plus its metadata, so a
run can be listed, downloaded and deleted as a single thing. Runs live outside
the source tree - the app may be running from a read-only mount, and data should
not land in the repo either way.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import tempfile
import time
import zipfile
from dataclasses import dataclass, asdict

DATA_ROOT = os.path.abspath(os.environ.get(
    "DAQ_DATA_DIR", os.path.join(os.path.expanduser("~"), "daq-runs")))

_SAFE = re.compile(r"[^A-Za-z0-9._-]+")


def slug(name: str) -> str:
    """A filesystem-safe stem. Empty or hostile input still yields something."""
    s = _SAFE.sub("-", (name or "").strip()).strip("-._")
    return s[:60] or "run"


@dataclass
class Run:
    id: str                 # the directory name: the run's one and only name
    started: float          # unix seconds
    files: int
    bytes: int
    channels: list[int]
    events: int | None = None

    def to_dict(self) -> dict:
        return asdict(self)


def _root() -> str:
    os.makedirs(DATA_ROOT, exist_ok=True)
    return DATA_ROOT


def create(name: str, timestamp: bool = True) -> tuple[str, str]:
    """Make a fresh run directory. Returns (run_name, path).

    The directory name IS the run's name - the one that appears in the listing,
    in the metadata and on the downloaded zip. With `timestamp` it gets an
    ISO-ish suffix, which is what keeps two runs of the same name apart; without
    it, a clash is an error rather than a silent rename.
    """
    base = slug(name)
    if timestamp:
        base = f"{base}-{time.strftime('%Y-%m-%d-%H%M%S')}"
    path = os.path.join(_root(), base)
    if os.path.exists(path):
        raise FileExistsError(base)
    os.makedirs(path)
    return base, path


def path_of(run_id: str) -> str | None:
    """Resolve an id to a directory, refusing anything outside the data root."""
    if not run_id or "/" in run_id or "\\" in run_id or run_id.startswith("."):
        return None
    p = os.path.abspath(os.path.join(_root(), run_id))
    if os.path.dirname(p) != os.path.abspath(_root()) or not os.path.isdir(p):
        return None
    return p


def _read_meta(path: str) -> dict:
    try:
        with open(os.path.join(path, "run_metadata.json")) as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return {}


def describe(run_id: str) -> Run | None:
    path = path_of(run_id)
    if path is None:
        return None
    meta = _read_meta(path)
    files = 0
    total = 0
    for entry in os.scandir(path):
        if entry.is_file():
            files += 1
            total += entry.stat().st_size
    chans = sorted(int(c) for c in (meta.get("channels") or {}))
    return Run(id=run_id,
               started=meta.get("started", os.path.getmtime(path)),
               files=files, bytes=total, channels=chans,
               events=meta.get("events"))


def listing() -> list[dict]:
    """Newest first."""
    out = []
    for entry in sorted(os.scandir(_root()), key=lambda e: e.name, reverse=True):
        if entry.is_dir():
            r = describe(entry.name)
            if r:
                out.append(r.to_dict())
    return out


def delete(run_id: str) -> bool:
    path = path_of(run_id)
    if path is None:
        return False
    shutil.rmtree(path)
    return True


def zip_to_temp(run_id: str) -> str | None:
    """Zip a run into a temp file and return its path; the caller unlinks it."""
    path = path_of(run_id)
    if path is None:
        return None
    fd, tmp = tempfile.mkstemp(suffix=".zip", prefix=f"{run_id}_")
    os.close(fd)
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as z:
        for entry in sorted(os.scandir(path), key=lambda e: e.name):
            if entry.is_file():
                z.write(entry.path, arcname=os.path.join(run_id, entry.name))
    return tmp
