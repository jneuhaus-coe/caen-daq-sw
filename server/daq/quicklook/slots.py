"""The ROOT file's channel[18] slot order, and what each slot needs.

maketree's interleaved layout (see writer.RootWriter): slot = group*9 +
ch_in_group, with each group's TR0 copy at in-group index 8. Quick Look
speaks DAQ numbers - inputs 0-15 and the two TR0 copies - and converts here.
"""
from __future__ import annotations

N_SLOTS = 18
TR0_SLOTS = (8, 17)

# TR0 enters through a x2 attenuator into the same 1 Vpp DRS4 (UM4270 sec
# 9.1.2), so a TR0 trace in window mV is half the input. Signal channels have
# no gain stage: window mV differences ARE input mV differences.
TR0_INPUT_SCALE = 2.0

# maketree's amplitude convention puts ADC codes 0 and 4095 at -500/+500 mV.
# DRS4-corrected samples are floats and can land a hair inside, so clipping
# is anything within 2 mV of either rail.
CLIP_MV = 498.0


def slot_of_input(ch: int) -> int:
    return (ch // 8) * 9 + (ch % 8)


def group_of_slot(slot: int) -> int:
    return slot // 9


def scale_of_slot(slot: int) -> float:
    return TR0_INPUT_SCALE if slot in TR0_SLOTS else 1.0


def parse_source(src) -> int | None:
    """A channel source as the UI names it -> ROOT slot, or None for off.

    "in:5" is input 5, "tr0:0"/"tr0:1" are group 0/1's copy of TR0."""
    if not isinstance(src, str):
        return None
    kind, _, num = src.partition(":")
    try:
        n = int(num)
    except ValueError:
        return None
    if kind == "in" and 0 <= n < 16:
        return slot_of_input(n)
    if kind == "tr0" and n in (0, 1):
        return TR0_SLOTS[n]
    return None


def source_name(slot: int) -> str:
    if slot in TR0_SLOTS:
        return f"TR0 (group {TR0_SLOTS.index(slot)} copy)"
    g, i = divmod(slot, 9)
    return f"input {g * 8 + i}"
