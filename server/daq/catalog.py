"""Browsable command/setting catalog, organized by tier (board / bank / channel).
Drives the UI and documents the underlying CAEN call for each setting."""
from __future__ import annotations

from . import constants as C

FREQ_CHOICES = [{"value": k, "label": v[0]} for k, v in C.DRS4_FREQUENCIES.items()]
TRIG_MODES = [{"value": "disabled", "label": "Disabled"},
              {"value": "acquisition_only", "label": "Acquisition only"},
              {"value": "acq_and_trgout", "label": "Acq + TRG-OUT"}]

BOARD_SETTINGS = [
    {"key": "drs4_frequency", "label": "Sampling frequency", "type": "enum",
     "choices": FREQ_CHOICES, "caen": "CAEN_DGTZ_SetDRS4SamplingFrequency",
     "help": "DRS4 sample rate (whole board). Correction tables reload on change."},
    {"key": "post_trigger", "label": "Post-trigger", "type": "int", "min": 0, "max": 100,
     "unit": "%", "caen": "CAEN_DGTZ_SetPostTriggerSize"},
    {"key": "correction_level", "label": "DRS4 correction", "type": "enum",
     "choices": [{"value": "auto", "label": "Auto"}, {"value": "disabled", "label": "Disabled"},
                 {"value": "manual", "label": "Manual tables"}],
     "caen": "CAEN_DGTZ_LoadDRS4CorrectionData / EnableDRS4Correction"},
    {"key": "trigger_edge", "label": "Trigger edge", "type": "enum",
     "choices": [{"value": "rising", "label": "Rising"}, {"value": "falling", "label": "Falling"}],
     "caen": "CAEN_DGTZ_SetTriggerPolarity"},
    {"key": "external_trigger", "label": "External trigger (TRG-IN)", "type": "enum",
     "choices": TRIG_MODES, "caen": "CAEN_DGTZ_SetExtTriggerInputMode"},
    {"key": "fast_trigger", "label": "Fast trigger (TR0/TR1)", "type": "enum",
     "choices": TRIG_MODES[:2], "caen": "CAEN_DGTZ_SetFastTriggerMode"},
    {"key": "fast_trigger_digitizing", "label": "Digitize TR traces", "type": "bool",
     "caen": "CAEN_DGTZ_SetFastTriggerDigitizing"},
    {"key": "max_events_blt", "label": "Events per readout", "type": "int",
     "min": 1, "max": 1024, "caen": "CAEN_DGTZ_SetMaxNumEventsBLT"},
    {"key": "output_format", "label": "Dump format", "type": "enum",
     "choices": [{"value": "ascii", "label": "ASCII"}, {"value": "binary", "label": "Binary"}]},
    {"key": "output_header", "label": "Dump header", "type": "bool"},
    {"key": "write_enabled", "label": "Write to disk", "type": "bool"},
]

# Per DRS4 group of 8 channels.
BANK_SETTINGS = [
    {"key": "enabled", "label": "Bank enabled", "type": "bool",
     "caen": "CAEN_DGTZ_SetGroupEnableMask",
     "help": "The DRS4 digitizes all 8 channels in the bank together — enable is per-bank."},
    {"key": "self_trigger", "label": "Self-trigger", "type": "enum",
     "choices": TRIG_MODES, "caen": "CAEN_DGTZ_SetGroupSelfTrigger"},
    {"key": "trigger_threshold", "label": "Self-trigger threshold", "type": "int",
     "min": 0, "max": 4095, "caen": "CAEN_DGTZ_SetGroupTriggerThreshold"},
    {"key": "fast_trigger_threshold", "label": "Fast-trigger (TR) threshold", "type": "int",
     "min": 0, "max": 65535, "caen": "CAEN_DGTZ_SetGroupFastTriggerThreshold"},
    {"key": "fast_trigger_dc_offset", "label": "Fast-trigger (TR) DC offset", "type": "int",
     "min": 0, "max": 65535, "caen": "CAEN_DGTZ_SetGroupFastTriggerDCOffset"},
]

CHANNEL_SETTINGS = [
    {"key": "dc_offset", "label": "DC offset", "type": "int", "min": -32768, "max": 32767,
     "caen": "CAEN_DGTZ_SetChannelDCOffset",
     "help": "Per-channel baseline trim. (The 742 has no per-channel gain.)"},
]


def catalog() -> dict:
    return {
        "board": BOARD_SETTINGS,
        "bank": BANK_SETTINGS,
        "channel": CHANNEL_SETTINGS,
        "geometry": {
            "num_channels": C.NUM_CHANNELS,
            "group_size": C.GROUP_SIZE,
            "num_groups": C.NUM_GROUPS,
            "record_length": C.RECORD_LENGTH,
        },
    }
