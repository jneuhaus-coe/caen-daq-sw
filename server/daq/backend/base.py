"""The hardware seam.

Everything above this line (acquisition, stats, writer, server, UI) talks only
to `DigitizerBackend`; `CaenBackend` is the implementation. Hardware debugging
stays behind this seam.
"""
from __future__ import annotations

import abc
from dataclasses import dataclass, field
from typing import Optional

import numpy as np

from .. import constants as C


@dataclass
class BoardInfo:
    model: str = "DT5742B"
    family_code: str = "XX742"
    serial: int = 0
    roc_firmware: str = ""
    amc_firmware: str = ""
    sw_release: str = ""     # CAEN_DGTZ_SWRelease, filled by real backend at runtime


@dataclass
class Event:
    """One trigger's worth of corrected waveforms.

    samples: {absolute_channel_index: float32 array of length record_length}.
    For the 742 these are DRS4-corrected (baseline/time/peak) millivolt-ish
    ADC counts as floats, matching CAEN's Event742 after ApplyDataCorrection.
    """
    index: int
    timestamp_s: float
    trigger_time_tag: int
    samples: dict[int, np.ndarray] = field(default_factory=dict)


class DigitizerBackend(abc.ABC):
    """Abstract digitizer. Lifecycle: open -> configure -> start -> read* -> stop -> close."""

    @abc.abstractmethod
    def open(self) -> BoardInfo: ...

    @abc.abstractmethod
    def configure(self, cfg) -> None: ...

    @abc.abstractmethod
    def start(self) -> None: ...

    @abc.abstractmethod
    def stop(self) -> None: ...

    @abc.abstractmethod
    def read_events(self) -> list[Event]:
        """Return zero or more events available since the last call. Non-blocking-ish."""
        ...

    @abc.abstractmethod
    def close(self) -> None: ...

    # convenience
    @property
    def record_length(self) -> int:
        return C.RECORD_LENGTH


def make_backend(kind: str = "caen", **kwargs) -> DigitizerBackend:
    if (kind or "caen").lower() in ("caen", "real", "hw", "hardware"):
        from .caen import CaenBackend
        return CaenBackend(**kwargs)
    raise ValueError(f"unknown backend {kind!r} (use 'caen')")
