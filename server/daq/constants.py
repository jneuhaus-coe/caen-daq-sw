"""CAEN DT5742B / x742-family hardware constants.

Seeded from CAEN's own WaveDump reference (WaveDumpConfig.txt defaults and the
x742 init sequence in WaveDump.c). Kept in one place so the backend and the
real backend agree on geometry.
"""
from __future__ import annotations

# --- Board geometry (fixed by the DRS4 architecture) ---
NUM_CHANNELS = 16          # 16 input channels
GROUP_SIZE = 8             # channels per DRS4 chip / group
NUM_GROUPS = NUM_CHANNELS // GROUP_SIZE  # 2 groups
NUM_TR = NUM_GROUPS        # one fast-trigger (TRn) digitized trace per group
RECORD_LENGTH = 1024       # DRS4 depth: samples per event, fixed
ADC_BITS = 12
ADC_MAX = (1 << ADC_BITS) - 1  # 4095
INPUT_RANGE_VPP = 1.0      # DT5742B dynamic range: 1 Vpp across the full ADC span
# The per-channel DC-offset DAC spans +/-1 V (742 datasheet), i.e. TWICE the
# 1 Vpp window - so only about half the DAC range keeps the window in view.
# Measured on serial 53364: 0.137 ADC counts per DAC LSB => 2.19 V total,
# against a 0.125 / 2.00 V nominal. Increasing the DAC LOWERS the baseline.
# There is no second, summable DC offset: SetGroupDCOffset is
# CAEN_DGTZ_FunctionNotAllowed on the x742 and the library has no V1742
# implementation of it. The only group-level offset is the TR0/TR1 fast trigger.
DC_OFFSET_RANGE_V = 2.0    # total span, i.e. +/-1 V
# CAEN_DGTZ_Set/GetChannelDCOffset take a uint32_t, so we follow the API: an
# unsigned 16-bit DAC word, midscale = no shift.
DC_OFFSET_MAX = 0xFFFF
DC_OFFSET_MID = 0x8000

# --- DRS4 sampling frequency enum (matches CAEN_DGTZ_DRS4Frequency_t) ---
# value : (label, sample_rate_Hz, sample_period_ns)
DRS4_FREQUENCIES = {
    0: ("5 GS/s", 5.0e9, 0.2),
    1: ("2.5 GS/s", 2.5e9, 0.4),
    2: ("1 GS/s", 1.0e9, 1.0),
    3: ("750 MS/s", 0.75e9, 1.0 / 0.75),
}
DEFAULT_DRS4_FREQUENCY = 0  # 5 GS/s, WaveDump default

# Display: waveforms are decimated to this many points for the 16-up overview
# grid (plenty to spot dead/railed channels; keeps the wire light).
OVERVIEW_POINTS = 256

# Fixed display aggregation: waveforms are averaged over a rolling time window
# and pushed at a fixed cadence (no user-facing moving-average slider).
AVG_WINDOW_SECONDS = 1.0
TELEMETRY_HZ = 12.0

# Trigger-rate strip: fixed rolling window.
RATE_BIN_SECONDS = 0.5
RATE_WINDOW_SECONDS = 60.0


def channel_group(ch: int) -> int:
    """Group index (DRS4 chip) that owns absolute channel `ch`. 742: ch // 8."""
    return ch // GROUP_SIZE


def sample_period_ns(drs4_freq: int) -> float:
    return DRS4_FREQUENCIES[drs4_freq][2]


def time_axis_ns(drs4_freq: int, n: int = RECORD_LENGTH):
    dt = sample_period_ns(drs4_freq)
    return [i * dt for i in range(n)]

# Connection health. The readout loop tolerates a few transient read errors
# before declaring the board gone; when idle we re-probe (and retry a lost
# board) at this cadence so the UI recovers on its own.
READ_FAIL_LIMIT = 10
RECONNECT_RETRY_S = 5.0

# The post-trigger register counts TIME, not percent: ~8.5 ns per step. The API
# takes a percentage, so the reachable percentages depend on how long the
# 1024-sample record is at the current sampling frequency — coarse at 5 GS/s
# (204.8 ns record -> 4.15% steps, only 25 values) and every whole percent at
# 1 GS/s or slower. Asking for anything else just gets silently snapped.
# Measured 8.45 ns on serial 53364 (ROC 04.29); CAEN document 8.5 ns.
POST_TRIGGER_STEP_NS = 8.5


def post_trigger_steps(drs4_freq: int) -> list[int]:
    """Post-trigger percentages the board can actually reach at this frequency."""
    record_ns = RECORD_LENGTH * sample_period_ns(drs4_freq)
    step = POST_TRIGGER_STEP_NS / record_ns * 100.0
    out, i = set(), 0
    while True:
        v = int(i * step)
        if v > 100:
            return sorted(out)
        out.add(v)
        i += 1


def snap_post_trigger(pct: int, drs4_freq: int) -> int:
    """Nearest reachable value, so we never ask for one the board must round."""
    steps = post_trigger_steps(drs4_freq)
    return min(steps, key=lambda s: (abs(s - pct), s))
