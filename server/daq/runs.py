"""Recorded runs on disk.

The data directory holds EXPERIMENTS, and each experiment holds its runs:

    <DAQ_DATA_DIR>/iowa-flash/run_002_10GeV-electrons/run_2.root
                                                     /run_metadata.json

An experiment is a plain folder; a run is a folder of its own named
run_<NNN>[_<label>], holding its data files and its own metadata, so a run
can be listed, downloaded and deleted as a single thing. A run's identity is
experiment + number - the label is description, never identity - and its id
on the API is "<experiment>/<run folder>".

Run numbers count per experiment, and the folders on disk are the whole
truth: a number is taken exactly while a run_<NNN> folder for it exists. So
an operator who deletes a bad run 3 in Explorer can record run 3 again.

Folders from before experiments existed (a run directly under the data
directory, recognised by its run_metadata.json) stay where they are and are
listed as runs with no experiment - their id is the bare folder name.

Runs live outside the source tree - the app may be running from a read-only
mount, and data should not land in the repo either way.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import tempfile
import zipfile
from dataclasses import dataclass, asdict

DATA_ROOT = os.path.abspath(os.environ.get(
    "DAQ_DATA_DIR", os.path.join(os.path.expanduser("~"), "daq-runs")))

META = "run_metadata.json"

_SAFE = re.compile(r"[^A-Za-z0-9._-]+")
# run_<digits>, then either the end or "_<label>". Padded to three digits on
# creation, but any width is read: run 1000 is run_1000.
_RUN_DIR = re.compile(r"^run_(\d+)(?:_(.*))?$")


def clean(name: str) -> str:
    """A filesystem-safe name, or "" when nothing usable is left."""
    return _SAFE.sub("-", (name or "").strip()).strip("-._")[:60]


@dataclass
class Run:
    id: str                 # "<experiment>/<run folder>", or a legacy folder name
    started: float          # unix seconds
    files: int
    bytes: int
    channels: list[int]
    events: int | None = None
    # The operator's note from record time - what was tested, beam energy -
    # so the listing can answer "which run was that?" without opening files.
    note: str = ""
    experiment: str = ""    # "" for a run from before experiments
    number: int | None = None
    label: str = ""

    def to_dict(self) -> dict:
        return asdict(self)


def _root() -> str:
    os.makedirs(DATA_ROOT, exist_ok=True)
    return DATA_ROOT


def _is_legacy_run(path: str) -> bool:
    """A run folder straight under the data directory (the old layout)."""
    return os.path.isfile(os.path.join(path, META))


def run_folder(number: int, label: str = "") -> str:
    label = clean(label)
    return f"run_{number:03d}" + (f"_{label}" if label else "")


def _numbers_in(exp_path: str) -> dict[int, str]:
    """Run number -> folder name, for every run folder in an experiment."""
    out: dict[int, str] = {}
    try:
        entries = list(os.scandir(exp_path))
    except OSError:
        return out
    for e in entries:
        m = _RUN_DIR.match(e.name)
        if m and e.is_dir():
            out[int(m.group(1))] = e.name
    return out


def experiments() -> dict[str, list[int]]:
    """Every experiment folder and the run numbers it holds, sorted.

    Read fresh on every call (the status poll), so a run deleted in Explorer
    frees its number within a poll. Only directory names are read - no
    metadata - so this stays cheap however many runs there are."""
    out: dict[str, list[int]] = {}
    try:
        entries = list(os.scandir(_root()))
    except OSError:
        return out
    for e in entries:
        if e.name.startswith(".") or not e.is_dir() or _is_legacy_run(e.path):
            continue
        out[e.name] = sorted(_numbers_in(e.path))
    return out


def _existing_experiment(name: str) -> str:
    """The on-disk spelling of an experiment, matched case-insensitively.

    Windows folders are case-insensitive, so "Iowa-Flash" and "iowa-flash"
    are the same folder - and the run's id must use the one spelling the
    listing shows, or the live run would not be recognised in it."""
    low = name.lower()
    for existing in experiments():
        if existing.lower() == low:
            return existing
    return name


def next_run_number(experiment: str) -> int:
    """One past the highest run number in the experiment; 1 for a new one."""
    exp = _existing_experiment(clean(experiment))
    if not exp:
        return 1
    nums = _numbers_in(os.path.join(_root(), exp))
    return max(nums, default=0) + 1


def create(experiment: str, number: int, label: str = "") -> tuple[str, str]:
    """Make a fresh run folder. Returns (run_id, path).

    Raises ValueError for a name that cannot be an experiment, and
    FileExistsError (carrying the folder that holds it) when the number is
    already taken in this experiment, whatever that run's label."""
    exp = clean(experiment)
    if not exp:
        raise ValueError("type an experiment name first")
    exp = _existing_experiment(exp)
    exp_path = os.path.join(_root(), exp)
    if _is_legacy_run(exp_path):
        raise ValueError(f"{exp!r} is a run folder from before experiments - "
                         f"pick another experiment name")
    taken = _numbers_in(exp_path).get(number)
    if taken is not None:
        raise FileExistsError(f"{exp}/{taken}")
    os.makedirs(exp_path, exist_ok=True)
    name = run_folder(number, label)
    path = os.path.join(exp_path, name)
    os.makedirs(path)
    return f"{exp}/{name}", path


def _split(run_id: str) -> list[str] | None:
    parts = (run_id or "").split("/")
    if not 1 <= len(parts) <= 2:
        return None
    for p in parts:
        if not p or "\\" in p or p.startswith(".") or ":" in p:
            return None
    return parts


def path_of(run_id: str) -> str | None:
    """Resolve an id to a run directory, refusing anything outside the data root."""
    parts = _split(run_id)
    if parts is None:
        return None
    root = os.path.abspath(_root())
    p = os.path.abspath(os.path.join(root, *parts))
    parent = os.path.dirname(p) if len(parts) == 1 else os.path.dirname(os.path.dirname(p))
    if parent != root or not os.path.isdir(p):
        return None
    if len(parts) == 2 and not _RUN_DIR.match(parts[1]):
        return None
    return p


def experiment_path_of(name: str) -> str | None:
    parts = _split(name)
    if parts is None or len(parts) != 1:
        return None
    p = os.path.join(os.path.abspath(_root()), parts[0])
    if not os.path.isdir(p) or _is_legacy_run(p):
        return None
    return p


def _read_meta(path: str) -> dict:
    try:
        with open(os.path.join(path, META)) as f:
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
    with os.scandir(path) as entries:
        for entry in entries:
            try:
                if entry.is_file():
                    files += 1
                    total += entry.stat().st_size
            except OSError:
                continue          # written to, or removed, while we looked
    chans = sorted(int(c) for c in (meta.get("channels") or {}))
    parts = run_id.split("/")
    if len(parts) == 2:
        m = _RUN_DIR.match(parts[1])
        experiment, number, label = parts[0], int(m.group(1)), m.group(2) or ""
    else:
        n = meta.get("run_number")
        experiment, number, label = "", n if isinstance(n, int) else None, ""
    return Run(id=run_id,
               started=meta.get("started", os.path.getmtime(path)),
               files=files, bytes=total, channels=chans,
               events=meta.get("events"),
               note=str(meta.get("note") or ""),
               experiment=experiment, number=number, label=label)


def listing() -> list[dict]:
    """Every run, experiments' and legacy alike, newest first by the start
    time in the metadata - not by name, which only sorts by time while every
    name happens to carry one."""
    ids: list[str] = []
    with os.scandir(_root()) as entries:
        tops = [e for e in entries if e.is_dir() and not e.name.startswith(".")]
    for top in tops:
        if _is_legacy_run(top.path):
            ids.append(top.name)
            continue
        for name in _numbers_in(top.path).values():
            ids.append(f"{top.name}/{name}")
    out = []
    for run_id in ids:
        r = describe(run_id)
        if r:
            out.append(r.to_dict())
    out.sort(key=lambda r: (r["started"], r["id"]), reverse=True)
    return out


def discard_empty(run_id: str) -> bool:
    """Remove a run directory that was created but never written to - and its
    experiment folder too, if that run was all it would have held.

    A run whose files could not be opened would otherwise sit in the listing
    looking like a recording that happened and produced nothing."""
    path = path_of(run_id)
    if path is None:
        return False
    with os.scandir(path) as entries:
        if any(True for _ in entries):
            return False
    try:
        os.rmdir(path)
    except OSError:
        return False
    if "/" in run_id:
        try:
            os.rmdir(os.path.dirname(path))     # only succeeds when empty
        except OSError:
            pass
    return True


def delete(run_id: str) -> bool:
    """True if it is gone. Raises OSError if the filesystem refused.

    The experiment folder stays, even when this was its last run: it is the
    operator's to remove, and an emptied experiment keeps its name in the
    dropdown for the redo."""
    path = path_of(run_id)
    if path is None:
        return False
    shutil.rmtree(path)
    return True


def _files_of(path: str) -> list[tuple[str, str]]:
    with os.scandir(path) as entries:
        return sorted((e.name, e.path) for e in entries if e.is_file())


def _zip(members: list[tuple[str, str]], prefix: str) -> str:
    """Zip (arcname, source) pairs into a temp file; the caller unlinks it."""
    fd, tmp = tempfile.mkstemp(suffix=".zip", prefix=f"{prefix}_")
    os.close(fd)
    try:
        with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as z:
            for arc, src in members:
                z.write(src, arcname=arc)
    except BaseException:
        # A half-written zip is worse than none: it downloads and then fails to
        # open. Take the partial file with us on the way out.
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    return tmp


def zip_name(run_id: str) -> str:
    """"iowa-flash/run_002_x" downloads as "iowa-flash_run_002_x"."""
    return run_id.replace("/", "_")


def zip_to_temp(run_id: str) -> str | None:
    """Zip one run. Its members sit under "<experiment>/<run folder>/", so
    unzipping several runs side by side rebuilds the experiment's tree."""
    path = path_of(run_id)
    if path is None:
        return None
    return _zip([(f"{run_id}/{name}", src) for name, src in _files_of(path)],
                zip_name(run_id))


def zip_experiment_to_temp(name: str, skip: str | None = None) -> str | None:
    """Zip a whole experiment, leaving out `skip` (the run still recording)."""
    exp_path = experiment_path_of(name)
    if exp_path is None:
        return None
    members = [(f"{name}/{f}", src) for f, src in _files_of(exp_path)]
    for folder in sorted(_numbers_in(exp_path).values()):
        if f"{name}/{folder}" == skip:
            continue
        members += [(f"{name}/{folder}/{f}", src)
                    for f, src in _files_of(os.path.join(exp_path, folder))]
    return _zip(members, name)
