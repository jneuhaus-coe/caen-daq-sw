"""Browsable command/setting catalog, organized by tier (unit / bank / channel).

Drives the UI. Every entry carries a `help` written for the operator - what the
setting does and what it costs - not a restatement of the CAEN function name.
The function name rides along separately for anyone reading the code.

`type: "volts"` means the wire value is a 16-bit DAC word but the UI must show
volts; nothing human-facing should present a raw DAC integer.
"""
from __future__ import annotations

from . import constants as C

FREQ_CHOICES = [{"value": k, "label": v[0]} for k, v in C.DRS4_FREQUENCIES.items()]
TRIG_MODES = [{"value": "disabled", "label": "Disabled"},
              {"value": "acquisition_only", "label": "Acquisition only"},
              {"value": "acq_and_trgout", "label": "Acq + TRG-OUT"}]

UNIT_SETTINGS = [
    {"key": "drs4_frequency", "label": "Sampling frequency", "type": "enum",
     "choices": FREQ_CHOICES, "caen": "CAEN_DGTZ_SetDRS4SamplingFrequency",
     "help": "How fast the DRS4 samples.\n\n"
             "The record is always 1024 cells, so this decides how much time "
             "you capture:\n"
             "    5 GS/s      204.8 ns\n"
             "    2.5 GS/s    409.6 ns\n"
             "    1 GS/s      1.02 us\n"
             "    750 MS/s    1.37 us\n\n"
             "Changing it reloads the correction tables and changes which "
             "post-trigger settings are reachable."},
    {"key": "post_trigger", "label": "Post-trigger duration", "type": "steps",
     "depends_on": "drs4_frequency",
     "values_by_freq": {
         str(f): [{"pct": p, "ns": round(p / 100.0 * C.record_ns(f), 2)}
                  for p in C.post_trigger_steps(f)]
         for f in C.DRS4_FREQUENCIES
     },
     "record_ns_by_freq": {str(f): round(C.record_ns(f), 2) for f in C.DRS4_FREQUENCIES},
     "caen": "CAEN_DGTZ_SetPostTriggerSize",
     "help": "How much of the record is captured AFTER the trigger fires.\n\n"
             "    0 ns    trigger at the very END - nothing after it\n"
             "    half    trigger centred in the record\n"
             "    full    trigger at the very START - nothing before it\n\n"
             "The register moves in ~8.5 ns steps and the API takes a whole "
             "percent, so the smallest increment depends on the sampling "
             "frequency:\n"
             "    5 GS/s      8.5 ns    (25 settings)\n"
             "    1 GS/s      10.24 ns  (every 1%)\n"
             "    750 MS/s    13.65 ns  (every 1%)\n\n"
             "The arrows walk exactly those settings."},
    {"key": "correction_level", "label": "DRS4 correction", "type": "enum",
     "choices": [{"value": "auto", "label": "Auto"}, {"value": "disabled", "label": "Disabled"},
                 {"value": "manual", "label": "Manual tables"}],
     "caen": "CAEN_DGTZ_LoadDRS4CorrectionData / EnableDRS4Correction",
     "help": "The DRS4 needs cell-by-cell correction before its samples mean "
             "anything - each capacitor has its own offset, timing and peak "
             "error.\n\n"
             "    Auto            apply CAEN's stored tables during decode\n"
             "    Disabled        raw cells, for diagnosing the chip itself\n"
             "    Manual tables   supply your own\n\n"
             "Leave this on Auto unless you know why you want it off."},
    {"key": "trigger_edge", "label": "Trigger edge", "type": "enum",
     "choices": [{"value": "rising", "label": "Rising"}, {"value": "falling", "label": "Falling"}],
     "caen": "CAEN_DGTZ_SetTriggerPolarity",
     "help": "Which way the signal must cross the threshold to fire.\n\n"
             "    Rising    for positive-going pulses\n"
             "    Falling   for negative-going pulses (PMTs, NIM)\n\n"
             "Despite the per-channel API, this unit applies one edge to "
             "every channel."},
    {"key": "external_trigger", "label": "External trigger (TRG-IN)", "type": "enum",
     "choices": TRIG_MODES, "caen": "CAEN_DGTZ_SetExtTriggerInputMode",
     "help": "Accept triggers on the front-panel TRG-IN connector.\n\n"
             "    Disabled          ignore TRG-IN\n"
             "    Acquisition only  trigger on it\n"
             "    Acq + TRG-OUT     trigger, and pass it out for chaining\n\n"
             "Carries about 115 ns of delay, against ~42 ns on the TR inputs."},
    {"key": "fast_trigger", "label": "Fast trigger (TR0/TR1)", "type": "enum",
     "choices": TRIG_MODES[:2], "caen": "CAEN_DGTZ_SetFastTriggerMode",
     "help": "Trigger from the dedicated TR inputs - the low-latency path, and "
             "the usual choice for timing work.\n\n"
             "TR0 serves bank 0, TR1 serves bank 1. Each has its own threshold "
             "and DC offset under Bank Settings.\n\n"
             "Carries about 42 ns of delay."},
    {"key": "fast_trigger_digitizing", "label": "Digitize TR traces", "type": "bool",
     "caen": "CAEN_DGTZ_SetFastTriggerDigitizing",
     "help": "Record the TR inputs alongside the channels, giving a timing "
             "reference in the data. Costs conversion time: dead time per event "
             "rises from 110 us to 181 us."},
    {"key": "max_events_blt", "label": "Events per readout", "type": "int",
     "min": 1, "max": 1023, "caen": "CAEN_DGTZ_SetMaxNumEventsBLT",
     "help": "Upper bound on how many events one readout may return - a cap, "
             "not a fixed batch: a read gives you whatever is waiting, up to "
             "this. Higher means fewer, larger transfers and better throughput "
             "at high rates; lower means the display updates sooner at low "
             "rates. Not the same thing as the board's 1024-event buffer."},
    {"key": "output_format", "label": "Dump format", "type": "enum",
     "choices": [{"value": "ascii", "label": "ASCII"}, {"value": "binary", "label": "Binary"}],
     "help": "How samples are written to disk.\n\n"
             "    ASCII    one decimal per line; readable, ~6x larger, slower\n"
             "    Binary   raw samples; what you want for a sustained run"},
    {"key": "output_header", "label": "Dump header", "type": "bool",
     "help": "Prepend WaveDump's per-event header (event size, channel, counter, "
             "trigger time tag). Needed to tell events apart in a binary file; "
             "leave off for a bare column of samples."},
    {"key": "write_enabled", "label": "Write to disk", "type": "bool",
     "help": "Master switch for recording. Off means the display still runs but "
             "nothing is written - no files are created and no data is kept."},
]

# Per DRS4 group of 8 channels.
BANK_SETTINGS = [
    {"key": "enabled", "label": "Bank enabled", "type": "bool",
     "caen": "CAEN_DGTZ_SetGroupEnableMask",
     "help": "The DRS4 digitizes all 8 channels of a bank together, so there is "
             "no per-channel enable. Disabling a bank you are not using cuts "
             "readout time and file size."},
    {"key": "fast_trigger_threshold", "label": "TR threshold", "type": "volts",
     "caen": "CAEN_DGTZ_SetGroupFastTriggerThreshold",
     "help": "Level the TR input must cross to fire the fast trigger. Set it "
             "well inside your pulse amplitude but clear of the baseline noise. "
             "CAEN's NIM default is DAC 20934."},
    {"key": "fast_trigger_dc_offset", "label": "TR DC offset", "type": "volts",
     "caen": "CAEN_DGTZ_SetGroupFastTriggerDCOffset",
     "help": "Shifts the TR input's baseline so the threshold has room to sit. "
             "Leave at midscale for NIM and other negative pulses; raise it for "
             "positive signals."},
]

CHANNEL_SETTINGS = [
    {"key": "dc_offset", "label": "DC offset", "type": "volts",
     "caen": "CAEN_DGTZ_SetChannelDCOffset",
     "help": "Moves this channel's baseline within the 1 Vpp window so the "
             "pulse fits without clipping. The DAC covers +/-1 V - twice the "
             "window - so only about half its travel keeps the channel in view. "
             "The 742 has no per-channel gain."},
]


def catalog() -> dict:
    return {
        "unit": UNIT_SETTINGS,
        "bank": BANK_SETTINGS,
        "channel": CHANNEL_SETTINGS,
        "geometry": {
            "num_channels": C.NUM_CHANNELS,
            "group_size": C.GROUP_SIZE,
            "num_groups": C.NUM_GROUPS,
            "record_length": C.RECORD_LENGTH,
            "adc_max": C.ADC_MAX,
            "input_range_vpp": C.INPUT_RANGE_VPP,
            "dc_offset_max": C.DC_OFFSET_MAX,
            "dc_offset_range_v": C.DC_OFFSET_RANGE_V,
            "dc_offset_mid": C.DC_OFFSET_MID,
        },
    }
