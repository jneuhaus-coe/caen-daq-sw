"""Per-board 0 V calibration: where this unit's ADC actually puts 0 V input.

UM4270 only promises that DC offset 0x8000 lands "ideally around" ADC code
2048. Measured on serial 53364 with every input terminated (2026-10-07): the
TR0 copies sit near 2200 and the signal channels near 2600 - 74 and 140 mV of
display error at the input. The comparator, by contrast, matched CAEN's
threshold arithmetic to within 2 mV, so without this file the digitized TR0
trace and its trigger line disagree.

One file per serial under the state directory, measured by the calibrator's
"zero" mode with KNOWN 0 V inputs (unplugged / 50 ohm) - never from a signal.
Per input (0-15 signal, 16/17 the TR0 copies) it holds ONE point: the code a
0 V input reads (zero_code) at that input's 0 V of offset (ref_dac: 0x8F00
for the channels, 0x8000 for TR0). The display moves it with the NOMINAL
offset slope - one measurement, no fitted slope. It is applied to the
DISPLAY only; recorded data is never touched.
"""
from __future__ import annotations

import json
import os
import time

from . import logsetup
from .runtime import state_dir

log = logsetup.get("daq.zerocal")

VERSION = 2   # 1 = the two-point (zero + slope) files; no longer read

# Re-reading a small JSON file per status poll is cheap, but there is no
# reason to parse it every second either.
_cache: dict[str, tuple[float, dict | None]] = {}


def path_for(serial: int) -> str:
    return os.path.join(state_dir(), "zerocal", f"zerocal-{int(serial)}.json")


def load(serial: int) -> dict | None:
    """The stored calibration for this serial, or None when there is none
    (or it is unreadable - logged, and treated as absent)."""
    if not serial:
        return None
    p = path_for(serial)
    try:
        mtime = os.path.getmtime(p)
    except OSError:
        _cache.pop(p, None)
        return None
    hit = _cache.get(p)
    if hit and hit[0] == mtime:
        return hit[1]
    data = None
    try:
        with open(p, encoding="utf-8") as f:
            d = json.load(f)
        if (d.get("version") == VERSION and int(d.get("serial", -1)) == int(serial)
                and isinstance(d.get("channels"), dict)):
            data = d
        else:
            log.warning("Ignoring %s: wrong version or serial", p)
    except (OSError, ValueError, TypeError) as e:
        log.warning("Ignoring %s: %s", p, e)
    _cache[p] = (mtime, data)
    return data


def save(serial: int, channels: dict[str, dict], meta: dict) -> dict:
    """Write atomically (temp file + replace), so a reader never sees half."""
    p = path_for(serial)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    data = {"version": VERSION, "serial": int(serial),
            "measured_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
            **meta, "channels": channels}
    tmp = p + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=1)
    os.replace(tmp, p)
    _cache.pop(p, None)
    logsetup.did(log, f"Saving the 0 V calibration for S/N {serial}", p)
    return data


def summary(serial: int) -> dict:
    """What /api/status carries: enough for the UI to notice a change."""
    d = load(serial)
    return {"applied": d is not None,
            "measured_at": d.get("measured_at") if d else None}
