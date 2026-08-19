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
