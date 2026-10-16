"""Stage-1 results on disk, under the app's state directory - never next to
the data. Keyed by the file's identity (path, size, mtime) and the exact
processing settings, so a hit is always current and a changed file or
setting is simply a miss. Pruned oldest-first past a size cap."""
from __future__ import annotations

import hashlib
import json
import os
import time

import numpy as np

from .. import runtime

CAP_BYTES = 4 * 1024 ** 3


_dir_override: str | None = None


def set_dir(d: str) -> None:
    """Pin the cache directory. The server passes its own to the workers so
    the two can never disagree (a spawned child recomputes the state dir
    from its environment, which a test harness may have changed)."""
    global _dir_override
    _dir_override = d


def cache_dir() -> str:
    d = _dir_override or os.path.join(runtime.state_dir(), "quicklook-cache")
    os.makedirs(d, exist_ok=True)
    return d


def file_sig(path: str) -> str:
    st = os.stat(path)
    raw = f"{os.path.abspath(path)}|{st.st_size}|{st.st_mtime_ns}"
    return hashlib.sha1(raw.encode()).hexdigest()[:20]


def proc_sig(proc: dict) -> str:
    return hashlib.sha1(json.dumps(proc, sort_keys=True).encode()).hexdigest()[:12]


def features_path(fsig: str, psig: str) -> str:
    return os.path.join(cache_dir(), f"f_{fsig}_{psig}.npy")


def avg_path(fsig: str) -> str:
    return os.path.join(cache_dir(), f"a_{fsig}.npz")


def load_features(fsig: str, psig: str):
    p = features_path(fsig, psig)
    if not os.path.exists(p):
        return None
    try:
        a = np.load(p, mmap_mode="r")
        os.utime(p)                       # recently used: pruned last
        return a
    except (OSError, ValueError):
        return None


def save_features(fsig: str, psig: str, table: np.ndarray) -> str:
    p = features_path(fsig, psig)
    tmp = p + f".{os.getpid()}.tmp"
    with open(tmp, "wb") as f:
        np.save(f, table)
    os.replace(tmp, p)
    prune()
    return p


def load_avg(fsig: str):
    p = avg_path(fsig)
    if not os.path.exists(p):
        return None
    try:
        with np.load(p) as z:
            return z["x"], z["t"], int(z["n"])
    except (OSError, ValueError, KeyError):
        return None


def save_avg(fsig: str, x, t, n: int) -> None:
    p = avg_path(fsig)
    tmp = p + f".{os.getpid()}.tmp.npz"
    np.savez(tmp, x=x, t=t, n=np.array(n))
    os.replace(tmp, p)


def prune(cap: int = CAP_BYTES) -> None:
    try:
        entries = [(e.stat().st_mtime, e.stat().st_size, e.path)
                   for e in os.scandir(cache_dir()) if e.is_file()]
    except OSError:
        return
    total = sum(s for _, s, _ in entries)
    for _, size, path in sorted(entries):
        if total <= cap:
            break
        if path.endswith(".tmp") or ".tmp." in path:
            if time.time() - os.path.getmtime(path) < 3600:
                continue                   # a pass still writing it
        try:
            os.unlink(path)
            total -= size
        except OSError:
            pass
