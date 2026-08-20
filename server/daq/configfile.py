"""Reading and writing config files.

Two formats are accepted on load:

* **Ours** - JSON, a superset: every setting plus channel names.
* **CAEN WaveDumpConfig.txt** - sectioned key/value text, so an existing
  WaveDump setup can be brought straight in.

WaveDump expresses DC_OFFSET as a *percentage of full scale* (-50..+50), not as
the DAC word the API takes, so it is converted on the way in.
"""
from __future__ import annotations

import json
import re

from .config import BoardConfig, default_config
from . import constants as C

FORMAT = "dt5742b-daq/config"
VERSION = 1

# Settings that only take effect when the board is re-armed.
RESTART_KEYS = {"drs4_frequency", "correction_level", "record_length"}

_TRIG = {"DISABLED": "disabled", "ACQUISITION_ONLY": "acquisition_only",
         "ACQUISITION_AND_TRGOUT": "acq_and_trgout"}
_YESNO = {"YES": True, "NO": False, "TRUE": True, "FALSE": False}


def dc_percent_to_dac(pct: float) -> int:
    """WaveDump's -50..+50 % of full scale -> the uint16 DAC word."""
    dac = round(C.DC_OFFSET_MID + (pct / 100.0) * (C.DC_OFFSET_MAX + 1))
    return max(0, min(C.DC_OFFSET_MAX, dac))


def dac_to_dc_percent(dac: int) -> float:
    return round((dac - C.DC_OFFSET_MID) / (C.DC_OFFSET_MAX + 1) * 100.0, 3)


# ---------- writing ----------
def to_json(cfg: BoardConfig, include_names: bool = True) -> str:
    d = cfg.to_dict()
    if not include_names:
        for ch in d["channels"]:
            ch.pop("name", None)
    return json.dumps({"format": FORMAT, "version": VERSION, "config": d}, indent=2)


# ---------- reading ----------
def from_text(text: str) -> tuple[BoardConfig, list[str]]:
    """Parse either format. Returns (config, notes)."""
    stripped = text.lstrip()
    if stripped.startswith("{"):
        return _from_json(text)
    return _from_wavedump(text)


def _from_json(text: str) -> tuple[BoardConfig, list[str]]:
    d = json.loads(text)
    notes: list[str] = []
    if isinstance(d, dict) and "config" in d:
        if d.get("format") != FORMAT:
            notes.append(f"file declares format {d.get('format')!r}; read anyway")
        d = d["config"]
    return BoardConfig.from_dict(d), notes


def _from_wavedump(text: str) -> tuple[BoardConfig, list[str]]:
    cfg = default_config()
    notes: list[str] = []
    section = "COMMON"
    seen_enable: dict[int, bool] = {}

    for raw in text.splitlines():
        line = raw.split("#")[0].strip()
        if not line:
            continue
        m = re.fullmatch(r"\[(.+?)\]", line)
        if m:
            section = m.group(1).strip().upper()
            continue
        parts = line.split()
        key, val = parts[0].upper(), (parts[1] if len(parts) > 1 else "")
        rest = parts[1:]

        try:
            if section == "COMMON":
                _common(cfg, key, val, rest, notes)
            elif section.startswith("TR"):
                _tr(cfg, section, key, val, notes)
            elif section.isdigit():
                _channel(cfg, int(section), key, val, seen_enable, notes)
        except (ValueError, IndexError):
            notes.append(f"could not read {key} {val!r}")

    # WaveDump enables per channel; this board enables per bank of 8.
    for ch, on in seen_enable.items():
        gr = C.channel_group(ch)
        if on and not cfg.groups[gr].enabled:
            cfg.groups[gr].enabled = True
    if seen_enable:
        per_bank = {}
        for ch, on in seen_enable.items():
            per_bank.setdefault(C.channel_group(ch), set()).add(on)
        for gr, vals in per_bank.items():
            if len(vals) > 1:
                notes.append(
                    f"bank {gr}: file enables only some of its channels; the DRS4 "
                    f"digitizes all 8 together, so the whole bank is enabled")
    return cfg, notes


def _common(cfg, key, val, rest, notes):
    if key == "RECORD_LENGTH":
        if int(val) != C.RECORD_LENGTH:
            notes.append(f"RECORD_LENGTH {val} ignored: the DRS4 is fixed at "
                         f"{C.RECORD_LENGTH} samples")
    elif key == "POST_TRIGGER":
        cfg.post_trigger = max(0, min(100, int(val)))
    elif key == "DRS4_FREQUENCY":
        cfg.drs4_frequency = int(val)
    elif key == "EXTERNAL_TRIGGER":
        cfg.external_trigger = _TRIG.get(val.upper(), cfg.external_trigger)
    elif key == "FAST_TRIGGER":
        cfg.fast_trigger = _TRIG.get(val.upper(), cfg.fast_trigger)
    elif key == "ENABLED_FAST_TRIGGER_DIGITIZING":
        cfg.fast_trigger_digitizing = _YESNO.get(val.upper(), cfg.fast_trigger_digitizing)
    elif key == "TRIGGER_EDGE":
        cfg.trigger_edge = "falling" if val.upper() == "FALLING" else "rising"
    elif key == "MAX_NUM_EVENTS_BLT":
        cfg.max_events_blt = max(1, min(1023, int(val)))
    elif key == "OUTPUT_FILE_FORMAT":
        cfg.output_format = "binary" if val.upper() == "BINARY" else "ascii"
    elif key == "OUTPUT_FILE_HEADER":
        cfg.output_header = _YESNO.get(val.upper(), cfg.output_header)
    elif key == "ENABLE_INPUT":
        on = _YESNO.get(val.upper(), True)
        for g in cfg.groups:
            g.enabled = on
    elif key == "DC_OFFSET":
        dac = dc_percent_to_dac(float(val))
        for c in cfg.channels:
            c.dc_offset = dac
    elif key in ("GRP_CH_DC_OFFSET",):
        vals = [dc_percent_to_dac(float(x)) for x in re.split(r"[,\s]+", " ".join(rest)) if x]
        for i, dac in enumerate(vals[:C.NUM_CHANNELS]):
            cfg.channels[i].dc_offset = dac
    elif key in ("OPEN", "WRITE_REGISTER", "FPIO_LEVEL", "TEST_PATTERN",
                 "PULSE_POLARITY", "TRIGGER_THRESHOLD", "CHANNEL_TRIGGER",
                 "DECIMATION_FACTOR", "USE_INTERRUPT", "GNUPLOT_PATH"):
        pass                      # not applicable to this board / not ours to set
    else:
        notes.append(f"ignored unknown key {key}")


def _tr(cfg, section, key, val, notes):
    gr = 1 if section.endswith("1") else 0
    if gr >= C.NUM_GROUPS:
        return
    if key == "DC_OFFSET":
        cfg.groups[gr].fast_trigger_dc_offset = dc_percent_to_dac(float(val))
    elif key == "TRIGGER_THRESHOLD":
        cfg.groups[gr].fast_trigger_threshold = max(0, min(C.DC_OFFSET_MAX, int(val)))


def _channel(cfg, ch, key, val, seen_enable, notes):
    if ch >= C.NUM_CHANNELS:
        return
    if key == "ENABLE_INPUT":
        seen_enable[ch] = _YESNO.get(val.upper(), True)
    elif key == "DC_OFFSET":
        cfg.channels[ch].dc_offset = dc_percent_to_dac(float(val))


def needs_restart(before: BoardConfig, after: BoardConfig) -> list[str]:
    """Settings that changed and only take hold when the board is re-armed."""
    return [k for k in sorted(RESTART_KEYS)
            if getattr(before, k, None) != getattr(after, k, None)]
