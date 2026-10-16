"""A synthetic test-beam campaign for the fake backend and the tests.

NOT physics: just enough structure for Quick Look to have something to show
- a 4x4 pixel array whose pulses scale with beam energy, electrons narrow
and pions wide, ch 8 dead with its pixel cabled into TR0 (the last real
campaign's setup), one run with clipped events and one with a pedestal
step. Written through the real RootWriter, so the reader is tested against
exactly what the DAQ writes.
"""
from __future__ import annotations

import os

import numpy as np

from .. import constants as C
from .. import logsetup

log = logsetup.get("daq.quicklook")

FOLDER = "fake-testbeam"
# (particle tag in the note, energy GeV, note text)
RUNS = [
    ("e", 2, "e- 2GeV"), ("e", 4, "e- 4 GeV"), ("e", 8, "electrons 8GeV, 0 deg"),
    ("e", 8, "electrons 8GeV, 0 deg, repeat"), ("e", 12, "e- 12GeV"),
    ("e", 16, "e- 16GeV"), ("e", 20, "e- 20GeV"),
    ("pi", 4, "pi+ 4GeV"), ("pi", 8, "pi+ 8GeV"), ("pi", 16, "pi+ 16GeV"),
    ("pi", 32, "pion 32 GeV"), ("pi", 60, "pi+ 60, last before access"),
]
CLIP_RUN = 5          # some events saturate
PED_RUN = 10          # pedestal steps by +6 mV
DEAD = 8              # input dead; its pixel is cabled into TR0


def _shape(t, t0):
    u = np.clip(t - t0[:, None], 0, None)
    s = np.exp(-u / 9.0) - np.exp(-u / 1.6)
    return s / 0.7275            # peak of that difference is ~0.7275


def _counts(mv):
    """Input mV -> the ADC code a 0 V-centred window reads, as an integer
    code like the real ADC (keeps the synthetic files small)."""
    return np.rint(mv * 4.095 + 2048.0).clip(0, C.ADC_MAX).astype(np.float32)


def write_campaign(root: str, events: int = 200, seed: int = 7) -> str:
    from ..config import default_config
    from ..writer import make_writer
    from ..backend.base import Event

    path = os.path.join(root, FOLDER)
    os.makedirs(path, exist_ok=True)
    rng = np.random.default_rng(seed)
    cfg = default_config()
    cfg.output_format = "root"
    for g in cfg.groups:
        g.enabled = True
    L = C.RECORD_LENGTH
    t = np.arange(L, dtype=np.float32) * 0.2           # 5 GS/s
    rows, cols = np.divmod(np.arange(16), 4)
    for number, (particle, energy, note) in enumerate(RUNS, start=1):
        w = make_writer(path, FOLDER, "root", number, note,
                        [{"key": "bias_V", "value": "42.0"},
                         {"key": "angle", "value": "0"}])
        w.open(cfg)
        e_like = particle == "e"
        spread = 0.85 if e_like else 1.4
        resp = 50.0 if e_like else 30.0                 # mV per GeV, summed
        stoch = 0.12 if e_like else 0.5
        for i in range(events):
            cx, cy = 1.35 + rng.normal(0, 0.25), 1.6 + rng.normal(0, 0.25)
            d = np.hypot(cols - cx, rows - cy)
            share = np.exp(-d / spread)
            share /= share.sum()
            total = energy * resp * max(0.05, 1 + rng.normal(
                0, stoch / np.sqrt(energy) + 0.03))
            if not e_like and rng.random() < 0.1:
                total *= 0.1                            # a late shower
            amp = total * share                         # mV per pixel
            if number == CLIP_RUN and rng.random() < 0.04:
                amp *= 6.0                              # pile-up: saturates
            t0 = 70.0 + rng.normal(0, 0.05) + 0.02 * np.arange(16)
            sig = -amp[:, None] * _shape(t[None, :], t0)  # (16, L) mV, negative
            sig += rng.normal(0, 0.7, (16, L))
            if number == PED_RUN:
                sig += 6.0
            samples = {}
            for ch in range(16):
                if ch == DEAD:
                    samples[ch] = _counts(rng.normal(0, 0.7, L) +
                                          (6.0 if number == PED_RUN else 0))
                else:
                    samples[ch] = _counts(sig[ch])
            # TR0: the dead pixel's pulse, through TR0's x2 attenuator.
            tr = _counts(sig[DEAD] / 2.0)
            samples[16] = tr
            samples[17] = tr
            w.write(Event(index=i, timestamp_s=0.0, trigger_time_tag=i,
                          samples=samples, trigger_cells={0: 0, 1: 0}))
        w.close()
    return path


def seed() -> str:
    """Create the demo campaign once, under the state directory - NOT the
    data directory, where it would advance the real run numbering - and
    list it in Quick Look. Returns its path."""
    from .. import runtime
    from . import folder
    root = os.path.join(runtime.state_dir(), "demo-runs")
    path = os.path.join(root, FOLDER)
    if not os.path.isfile(os.path.join(path, f"run_{len(RUNS)}.root")):
        with logsetup.step(log, f"Writing the synthetic Quick Look campaign "
                                f"'{FOLDER}' (fake backend only)") as s:
            write_campaign(root)
            s.done(f"Wrote {len(RUNS)} synthetic runs")
    folder.EXTRA.append((path, f"{FOLDER} (synthetic)"))
    return path
