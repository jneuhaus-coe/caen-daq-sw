"""Named sessions and display preferences.

A session is a named snapshot of the whole operator-facing state: the board
config (which includes channel names) plus the display preferences (per-channel
waveform Y ranges). Hardware settings already survive daq restarts because the
unit holds them and is read at open - what a session adds is a NAME for a known
state, one click back to it after a board power-cycle, and persistence for the
display state that lives nowhere else.

Sessions are plain JSON files in <state dir>/sessions, deliberately the same
"config" payload the Save/Load buttons speak, so a session can be diffed,
copied to another machine, or fed straight to the Load button. Applying a
session writes the hardware ONLY when explicitly asked - never at startup:
a restart that silently re-applied week-old offsets mid-beam would be a
disaster, and the board's own settings are already the truth.
"""
from __future__ import annotations

import json
import os
import re
import time
from typing import Optional

from . import runtime

_NAME_RE = re.compile(r"[^A-Za-z0-9 ._-]+")


def _dir() -> str:
    return os.path.join(runtime.state_dir(), "sessions")


def _display_path() -> str:
    return os.path.join(runtime.state_dir(), "display.json")


def safe_name(name: str) -> str:
    """A session name is also its filename: strip anything path-like."""
    return _NAME_RE.sub("", name).strip()[:80]


def _path(name: str) -> str:
    return os.path.join(_dir(), safe_name(name) + ".json")


# ---------- display preferences (the "current" state, autosaved) ----------
def get_display() -> dict:
    try:
        with open(_display_path()) as f:
            d = json.load(f)
    except (OSError, ValueError):
        return {}
    return d if isinstance(d, dict) else {}


def set_display(display: dict) -> None:
    os.makedirs(runtime.state_dir(), exist_ok=True)
    tmp = _display_path() + ".tmp"
    with open(tmp, "w") as f:
        json.dump(display, f, indent=2)
    os.replace(tmp, _display_path())


# ---------- named sessions ----------
def listing() -> list[dict]:
    try:
        files = os.listdir(_dir())
    except OSError:
        return []
    out = []
    for fn in sorted(files):
        if not fn.endswith(".json"):
            continue
        try:
            with open(os.path.join(_dir(), fn)) as f:
                d = json.load(f)
            out.append({"name": d.get("name") or fn[:-5],
                        "saved_at": d.get("saved_at")})
        except (OSError, ValueError):
            continue                  # a corrupt file must not hide the rest
    out.sort(key=lambda s: s.get("saved_at") or 0, reverse=True)
    return out


def save(name: str, config: dict, display: dict) -> Optional[dict]:
    name = safe_name(name)
    if not name:
        return None
    os.makedirs(_dir(), exist_ok=True)
    record = {"format": "dt5742b-daq/session", "version": 1,
              "name": name, "saved_at": time.time(),
              "config": config, "display": display}
    tmp = _path(name) + ".tmp"
    with open(tmp, "w") as f:
        json.dump(record, f, indent=2)
    os.replace(tmp, _path(name))
    return {"name": name, "saved_at": record["saved_at"]}


def load(name: str) -> Optional[dict]:
    try:
        with open(_path(name)) as f:
            d = json.load(f)
    except (OSError, ValueError):
        return None
    return d if isinstance(d, dict) and isinstance(d.get("config"), dict) else None


def delete(name: str) -> bool:
    try:
        os.remove(_path(name))
        return True
    except OSError:
        return False
