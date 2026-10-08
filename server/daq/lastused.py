"""The settings the unit cannot hold, kept on disk so a daq restart keeps them.

Most settings are board registers: they survive our process restarts (not a
power cycle) and are read back at every open - the board is the truth for
them. These are not:

  channel names, correction_level, output_format, output_header
      exist only in this program - nothing on the unit stores them.
  max_events_blt
      enforced by libCAENDigitizer in its own memory (register 0x800C reads
      a constant 10 on this board), so every new process or reopened handle
      starts again from the library's default.

Before this file they silently reset to defaults on every daq restart:
channel names blank, correction back to "timing". Saved on every adopted
config, loaded once as the engine's seed. Never an authority over anything
the board reports.
"""
from __future__ import annotations

import json
import os

from . import logsetup
from . import runtime
from .config import BoardConfig

log = logsetup.get("daq.lastused")

APP_SIDE = ("correction_level", "output_format", "output_header", "max_events_blt")


# What is on disk (keyed by path, which follows the state dir), so saving an
# unchanged config costs nothing.
_saved: tuple[str, dict] | None = None


def _path() -> str:
    return os.path.join(runtime.state_dir(), "last_used.json")


def snapshot(cfg: BoardConfig) -> dict:
    return {**{k: getattr(cfg, k) for k in APP_SIDE},
            "names": [c.name for c in cfg.channels]}


def load() -> dict:
    try:
        with open(_path()) as f:
            d = json.load(f)
    except (OSError, ValueError):
        return {}
    return d if isinstance(d, dict) else {}


def apply(cfg: BoardConfig, saved: dict | None = None) -> BoardConfig:
    """`cfg` with the saved app-side values laid over it, validated the same
    way any config is (a hand-edited file cannot smuggle in a bad value)."""
    saved = load() if saved is None else saved
    d = cfg.to_dict()
    for k in APP_SIDE:
        if k in saved:
            d[k] = saved[k]
    names = saved.get("names")
    if isinstance(names, list):
        for ch, n in zip(d["channels"], names):
            if isinstance(n, str):
                ch["name"] = n
    return BoardConfig.from_dict(d)


def save(cfg: BoardConfig) -> None:
    """Write if anything app-side changed. A failure is logged, never raised:
    losing this file costs names, not data."""
    global _saved
    snap = snapshot(cfg)
    if _saved is None or _saved[0] != _path():
        _saved = (_path(), load())
    if snap == _saved[1]:
        return
    try:
        os.makedirs(runtime.state_dir(), exist_ok=True)
        tmp = _path() + ".tmp"
        with open(tmp, "w") as f:
            json.dump(snap, f, indent=2)
        os.replace(tmp, _path())
        _saved = (_path(), snap)
    except OSError as e:
        log.warning("Could not save the last-used settings: %s", e)
