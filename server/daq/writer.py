"""Data writers behind a small interface so new formats (ROOT, HDF5, ...) drop
in later without touching acquisition.

v1 target: WaveDump-compatible output. WaveDump writes one file per channel
(wave_<ch>.txt / .dat). ASCII = optional 7-line header then one sample per line.
Binary = optional 6x uint32 header then samples. For the 742, corrected samples
are floats.

NOTE (validation pending): byte-exactness vs a real WaveDump dump has not been
checked against hardware output yet — a sample .dat from the board will let us
confirm/lock the layout. The structure below follows WaveDump.c/WriteOutputFiles.
"""
from __future__ import annotations

import abc
import json
import os
import struct
import time

from .backend.base import Event
from . import logsetup

log = logsetup.get("daq.writer")


class Writer(abc.ABC):
    @abc.abstractmethod
    def open(self, cfg) -> None: ...
    @abc.abstractmethod
    def write(self, ev: Event) -> None: ...
    @abc.abstractmethod
    def close(self) -> None: ...


class NullWriter(Writer):
    def open(self, cfg): pass
    def write(self, ev): pass
    def close(self): pass


class WaveDumpWriter(Writer):
    def __init__(self, directory: str, run_name: str = ""):
        self._files = {}
        self._cfg = None
        self._ascii = True
        self._header = False
        self._dir = directory
        self._run_name = run_name
        self._events = 0

    def open(self, cfg) -> None:
        self._ascii = (cfg.output_format.lower() == "ascii")
        self._header = bool(cfg.output_header)
        os.makedirs(self._dir, exist_ok=True)
        ext = "txt" if self._ascii else "dat"
        mode = "w" if self._ascii else "wb"
        self._files = {}
        try:
            for ch in cfg.enabled_channels():
                path = os.path.join(self._dir, f"wave_{ch}.{ext}")
                self._files[ch] = open(path, mode)
            self._write_metadata(cfg)
            self._cfg = cfg         # last: close() takes this as "there is a run"
        except OSError:
            # Do not leave half a run open: the caller discards the directory,
            # and on Windows it cannot remove files we still hold. With _cfg
            # still unset, close() knows there is no metadata to stamp.
            self.close()
            raise

    def _write_metadata(self, cfg) -> None:
        """Channel names and settings go in a sidecar, not the WaveDump header -
        that header layout is fixed and the point of this writer is byte
        compatibility. Names are stored bare, without the UI's "CH n - " prefix."""
        meta = {
            "run_name": self._run_name,
            "started": time.time(),
            "channels": {
                str(ch): {"name": cfg.channels[ch].name,
                          "dc_offset": cfg.channels[ch].dc_offset}
                for ch in cfg.enabled_channels()
            },
            "drs4_frequency": cfg.drs4_frequency,
            "record_length": cfg.record_length,
            "post_trigger": cfg.post_trigger,
        }
        with open(os.path.join(self._dir, "run_metadata.json"), "w") as f:
            json.dump(meta, f, indent=2)

    def write(self, ev: Event) -> None:
        self._events += 1
        for ch, wave in ev.samples.items():
            f = self._files.get(ch)
            if f is None:
                continue
            if self._ascii:
                if self._header:
                    self._write_ascii_header(f, ch, ev, len(wave))
                f.write("\n".join(f"{v:.6f}" for v in wave))
                f.write("\n")
            else:
                payload = wave.astype("<f4").tobytes()
                if self._header:
                    # WaveDump binary header: 6 x uint32. The size must describe
                    # the bytes that follow it, which are always 4 per sample -
                    # not wave.nbytes, which is whatever dtype arrived.
                    f.write(struct.pack(
                        "<6I", 24 + len(payload), self._cfg_board_id(), 0, ch,
                        ev.index & 0xFFFFFFFF, ev.trigger_time_tag & 0xFFFFFFFF,
                    ))
                f.write(payload)

    def _write_ascii_header(self, f, ch, ev, n):
        f.write(f"Record Length: {n}\n")
        f.write("BoardID: 0\n")
        f.write(f"Channel: {ch}\n")
        f.write(f"Event Number: {ev.index}\n")
        f.write("Pattern: 0x0000\n")
        f.write(f"Trigger Time Stamp: {ev.trigger_time_tag}\n")
        f.write(f"DC offset (DAC): {self._cfg.channels[ch].dc_offset:04x}\n")

    def _cfg_board_id(self) -> int:
        return 0

    def close(self) -> None:
        for ch, f in self._files.items():
            try:
                f.close()
            except OSError as e:
                # A failed close means buffered samples never reached the disk.
                # Keep closing the rest, but do not lose the fact that this
                # channel's file is short.
                log.error("wave file for channel %d did not close cleanly, so its "
                          "last events may be missing: %s", ch, e)
        self._files = {}
        # Stamp the final event count so a listing can show it without opening
        # every wave file. Losing this only costs the listing an event count, so
        # it must never take a close down - but it is worth a line in the log,
        # because a run that will not stamp usually cannot be written to either.
        if self._cfg is None:
            return
        path = os.path.join(self._dir, "run_metadata.json")
        try:
            with open(path) as f:
                meta = json.load(f)
            meta["events"] = self._events
            meta["ended"] = time.time()
            with open(path, "w") as f:
                json.dump(meta, f, indent=2)
        except (OSError, ValueError) as e:
            log.warning("Could not stamp the event count into %s: %s", path, e)


def make_writer(directory: str, run_name: str = "") -> Writer:
    return WaveDumpWriter(directory, run_name)
