"""Real CAEN DT5742B backend via ctypes over libCAENDigitizer.

STATUS: structurally faithful to CAEN's WaveDump x742 sequence, but NOT yet
validated on hardware (blocked on lsusb passthrough into the lima guest). The
call ORDER and the struct layouts are taken from CAENDigitizerType.h and
WaveDump.c; the numeric enum values and any per-group offset math are the most
likely things to need a tweak against the real board. Everything is isolated
here so validating it does not touch the rest of the app.

Correction strategy: we use the library's built-in DRS4 correction
(LoadDRS4CorrectionData + EnableDRS4Correction) so DecodeEvent returns already
cell/time/peak-corrected float samples — no software correction port needed.
"""
from __future__ import annotations

import ctypes as ct

import numpy as np

from .base import DigitizerBackend, Event, BoardInfo
from .. import constants as C

MAX_X742_CHANNEL_SIZE = 9   # 8 channels + TR trace
MAX_X742_GROUP_SIZE = 4     # library max; DT5742B populates 2

# --- CAEN_DGTZ enums we use (from CAENDigitizerType.h) ---
CAEN_DGTZ_Success = 0
# "not allowed for this module" - some getters simply do not exist on the x742
# (GetGroupTriggerThreshold and GetGroupSelfTrigger among them). Those settings
# are write-only here: we keep what we asked for, because nothing can confirm it.
CAEN_DGTZ_FunctionNotAllowed = -17
ConnectionType_USB = 0
AcqMode_SW_CONTROLLED = 0
TriggerMode_DISABLED = 0
TriggerMode_ACQ_ONLY = 1
TriggerMode_ACQ_AND_EXTOUT = 3
TriggerMode_EXTOUT_ONLY = 2
# DRS4 frequency enum values (0=5G,1=2.5G,2=1G,3=750M) — match our constants keys.

REG_ACQUISITION_STATUS = 0x8104   # read-only; used as a liveness probe

# --- codecs between our config vocabulary and CAEN's enums ---
_TRIGMODE = {"disabled": TriggerMode_DISABLED,
             "acquisition_only": TriggerMode_ACQ_ONLY,
             "extout_only": TriggerMode_EXTOUT_ONLY,
             "acq_and_trgout": TriggerMode_ACQ_AND_EXTOUT}
_EDGE = {"rising": 0, "falling": 1}


def _inv(d):
    return {v: k for k, v in d.items()}


def _codec(fwd, fallback):
    """(encode, decode) for a string<->int enum; unknown ints fall back."""
    rev = _inv(fwd)
    return (lambda v: fwd.get(v, fwd[fallback]),
            lambda v: rev.get(int(v), fallback))


_TRIG_ENC, _TRIG_DEC = _codec(_TRIGMODE, "disabled")
_EDGE_ENC, _EDGE_DEC = _codec(_EDGE, "falling")
_BOOL_ENC, _BOOL_DEC = (lambda v: 1 if v else 0), (lambda v: bool(v))
_INT_ENC, _INT_DEC = int, int

# attr, getter, setter, ctype, encode, decode
BOARD_HW = [
    ("max_events_blt", "GetMaxNumEventsBLT", "SetMaxNumEventsBLT", ct.c_uint32, _INT_ENC, _INT_DEC),
    ("drs4_frequency", "GetDRS4SamplingFrequency", "SetDRS4SamplingFrequency", ct.c_int, _INT_ENC, _INT_DEC),
    ("post_trigger", "GetPostTriggerSize", "SetPostTriggerSize", ct.c_uint32, _INT_ENC, _INT_DEC),
    ("external_trigger", "GetExtTriggerInputMode", "SetExtTriggerInputMode", ct.c_int, _TRIG_ENC, _TRIG_DEC),
    ("fast_trigger", "GetFastTriggerMode", "SetFastTriggerMode", ct.c_int, _TRIG_ENC, _TRIG_DEC),
    ("fast_trigger_digitizing", "GetFastTriggerDigitizing", "SetFastTriggerDigitizing", ct.c_int, _BOOL_ENC, _BOOL_DEC),
]
GROUP_HW = [
    ("fast_trigger_threshold", "GetGroupFastTriggerThreshold", "SetGroupFastTriggerThreshold", ct.c_uint32, _INT_ENC, _INT_DEC),
    ("fast_trigger_dc_offset", "GetGroupFastTriggerDCOffset", "SetGroupFastTriggerDCOffset", ct.c_uint32, _INT_ENC, _INT_DEC),
]


def _diff(want, got, skip=()) -> list[str]:
    """Settings the board did not accept as asked. Not fatal — `got` is still
    the state we keep — but the user should see that it disagreed."""
    out = []

    def cmp(label, a, b, key=None):
        if (key or label) in skip:
            return          # write-only on this model; nothing to compare against
        if a != b:
            out.append(f"{label}: requested {a!r}, board reports {b!r}")

    for attr, *_ in BOARD_HW:
        cmp(attr, getattr(want, attr), getattr(got, attr))
    cmp("trigger_edge", want.trigger_edge, got.trigger_edge)
    for gr in range(C.NUM_GROUPS):
        for attr in [a for a, *_ in GROUP_HW] + ["enabled"]:
            cmp(f"group {gr} {attr}",
                getattr(want.groups[gr], attr), getattr(got.groups[gr], attr), key=attr)
    for ch in range(C.NUM_CHANNELS):
        cmp(f"ch {ch} dc_offset",
            want.channels[ch].dc_offset, got.channels[ch].dc_offset)
    return out


class _X742_GROUP(ct.Structure):
    _fields_ = [
        ("ChSize", ct.c_uint32 * MAX_X742_CHANNEL_SIZE),
        ("DataChannel", ct.POINTER(ct.c_float) * MAX_X742_CHANNEL_SIZE),
        ("TriggerTimeTag", ct.c_uint32),
        ("StartIndexCell", ct.c_uint16),
    ]


class _X742_EVENT(ct.Structure):
    _fields_ = [
        ("GrPresent", ct.c_uint8 * MAX_X742_GROUP_SIZE),
        ("DataGroup", _X742_GROUP * MAX_X742_GROUP_SIZE),
    ]


class _EventInfo(ct.Structure):
    _fields_ = [
        ("EventSize", ct.c_uint32), ("BoardId", ct.c_uint32),
        ("Pattern", ct.c_uint32), ("ChannelMask", ct.c_uint32),
        ("EventCounter", ct.c_uint32), ("TriggerTimeTag", ct.c_uint32),
    ]


class _BoardInfoC(ct.Structure):
    _fields_ = [
        ("ModelName", ct.c_char * 12), ("Model", ct.c_uint32),
        ("Channels", ct.c_uint32), ("FormFactor", ct.c_uint32),
        ("FamilyCode", ct.c_uint32), ("ROC_FirmwareRel", ct.c_char * 20),
        ("AMC_FirmwareRel", ct.c_char * 40), ("SerialNumber", ct.c_uint32),
        ("MezzanineSerNum", (ct.c_char * 8) * 4), ("PCB_Revision", ct.c_uint32),
        ("ADC_NBits", ct.c_uint32), ("SAMCorrectionDataLoaded", ct.c_uint32),
        ("CommHandle", ct.c_int), ("VMEHandle", ct.c_int),
        ("License", ct.c_char * 17),
    ]


def _load_lib():
    for name in ("libCAENDigitizer.so", "libCAENDigitizer.so.1", "CAENDigitizer.dll"):
        try:
            return ct.CDLL(name)
        except OSError:
            continue
    raise OSError("libCAENDigitizer not found. Install CAEN's Linux driver+libs "
                  "(CAENComm, CAENVMELib, CAENDigitizer) in the guest.")


class CaenBackend(DigitizerBackend):
    def __init__(self, link_num: int = 0, conet_node: int = 0, vme_base: int = 0):
        self._lib = None
        self._h = ct.c_int(-1)
        self._link_num = link_num
        self._conet_node = conet_node
        self._vme_base = vme_base
        self._buf = ct.POINTER(ct.c_char)()
        self._buf_size = ct.c_uint32(0)
        self._evtptr = ct.c_void_p()      # decoded Event742
        self._cfg = None
        self._write_only: set[str] = set()    # settable, but not readable back
        self._unsupported: set[str] = set()   # the DT5742B rejects these outright
        self._state = None                    # last known board state, for deltas

    def _chk(self, ret, what):
        if ret != CAEN_DGTZ_Success:
            raise RuntimeError(f"CAEN_DGTZ error {ret} in {what}")

    def open(self) -> BoardInfo:
        self._lib = _load_lib()
        ret = self._lib.CAEN_DGTZ_OpenDigitizer(
            ConnectionType_USB, self._link_num, self._conet_node,
            self._vme_base, ct.byref(self._h))
        self._chk(ret, "OpenDigitizer")
        bi = _BoardInfoC()
        self._chk(self._lib.CAEN_DGTZ_GetInfo(self._h, ct.byref(bi)), "GetInfo")
        sw = ct.create_string_buffer(64)
        try:
            self._lib.CAEN_DGTZ_SWRelease(sw)
        except Exception:
            pass
        self._lib.CAEN_DGTZ_Reset(self._h)
        return BoardInfo(
            model=bi.ModelName.decode(errors="ignore"),
            family_code=str(bi.FamilyCode), serial=bi.SerialNumber,
            roc_firmware=bi.ROC_FirmwareRel.decode(errors="ignore"),
            amc_firmware=bi.AMC_FirmwareRel.decode(errors="ignore"),
            sw_release=sw.value.decode(errors="ignore"),
        )

    def is_alive(self) -> bool:
        """Read the acquisition-status register: a real USB round trip.

        GetInfo is NOT usable here - it answers from state the library cached
        at open time and keeps succeeding after the unit is switched off.
        """
        if not self._lib or self._h.value < 0:
            return False
        try:
            val = ct.c_uint32(0)
            return self._lib.CAEN_DGTZ_ReadRegister(
                self._h, REG_ACQUISITION_STATUS, ct.byref(val)) == CAEN_DGTZ_Success
        except Exception:
            return False

    # ---------- settings: the board is the source of truth ----------
    def _get(self, name, *args, ctype=ct.c_uint32):
        v = ctype(0)
        rc = getattr(self._lib, "CAEN_DGTZ_" + name)(self._h, *args, ct.byref(v))
        return rc, v.value

    def _set(self, name, *args):
        return getattr(self._lib, "CAEN_DGTZ_" + name)(self._h, *args)

    # Each _rd_* refreshes one setting on `out`; a getter the module refuses is
    # recorded as write-only rather than reported as a failure.
    def _rd(self, errs, label, getter, *args, ctype=ct.c_uint32, key=None):
        rc, v = self._get(getter, *args, ctype=ctype)
        if rc == CAEN_DGTZ_Success:
            return True, v
        if rc == CAEN_DGTZ_FunctionNotAllowed:
            self._write_only.add(key or label)
        else:
            errs.append(f"{label}: error {rc}")
        return False, None

    def _rd_board(self, out, spec, errs):
        attr, getter, _s, ctype, _e, dec = spec
        ok, v = self._rd(errs, getter, getter, ctype=ctype, key=attr)
        if ok:
            setattr(out, attr, dec(v))

    def _rd_mask(self, out, errs):
        ok, mask = self._rd(errs, "GetGroupEnableMask", "GetGroupEnableMask")
        if ok:
            for gr in range(C.NUM_GROUPS):
                out.groups[gr].enabled = bool(mask & (1 << gr))

    def _rd_edge(self, out, errs):
        ok, pol = self._rd(errs, "GetTriggerPolarity", "GetTriggerPolarity",
                           ct.c_uint32(0), ctype=ct.c_int, key="trigger_edge")
        if ok:
            out.trigger_edge = _EDGE_DEC(pol)

    def _rd_group(self, out, gr, spec, errs):
        attr, getter, _s, ctype, _e, dec = spec
        ok, v = self._rd(errs, f"{getter}[group {gr}]", getter,
                         ct.c_uint32(gr), ctype=ctype, key=attr)
        if ok:
            setattr(out.groups[gr], attr, dec(v))

    def _rd_channel(self, out, ch, errs):
        ok, v = self._rd(errs, f"GetChannelDCOffset[ch {ch}]", "GetChannelDCOffset",
                         ct.c_uint32(ch), key="dc_offset")
        if ok:
            out.channels[ch].dc_offset = int(v)

    def _blank(self, cfg):
        from ..config import BoardConfig
        return BoardConfig.from_dict(cfg.to_dict())

    def read_settings(self, cfg):
        """Full sweep: everything the board will tell us. Used on open."""
        out, errs = self._blank(cfg), []
        for spec in BOARD_HW:
            self._rd_board(out, spec, errs)
        self._rd_mask(out, errs)
        self._rd_edge(out, errs)
        for gr in range(C.NUM_GROUPS):
            for spec in GROUP_HW:
                self._rd_group(out, gr, spec, errs)
        for ch in range(C.NUM_CHANNELS):
            self._rd_channel(out, ch, errs)
        self._state = out
        return out, errs

    def write_settings(self, cfg):
        """Write only what changed, then read back only what was written.

        Re-writing every setting on every edit is needless bus traffic, and some
        setters have side effects nobody asked for. Reads are cheap but not free,
        so an untouched register is not re-read either - its cached value is
        still what the board last told us."""
        prev = self._state          # None => we know nothing, so do it all
        errs: list[str] = []
        out = self._blank(prev if prev is not None else cfg)
        reads = []                  # refresh exactly what we wrote
        wrote = False

        def put(name, *args):
            nonlocal wrote
            if name in self._unsupported:
                return False        # known-rejected on this model; stop asking
            rc = self._set(name, *args)
            wrote = True
            if rc == CAEN_DGTZ_FunctionNotAllowed:
                self._unsupported.add(name)
                errs.append(f"{name}: not supported on this model - ignored")
                return False
            if rc != CAEN_DGTZ_Success:
                errs.append(f"{name}: error {rc}")
            return True

        # The post-trigger register counts ~8.5 ns steps, so most percentages
        # are unreachable at 5 GS/s. Snap first rather than ask for one the
        # board would silently round.
        cfg.post_trigger = C.snap_post_trigger(cfg.post_trigger, cfg.drs4_frequency)

        for spec in BOARD_HW:
            attr, _g, setter, _ct, enc, _d = spec
            if prev is None or getattr(prev, attr) != getattr(cfg, attr):
                if put(setter, enc(getattr(cfg, attr))):
                    reads.append(lambda sp=spec: self._rd_board(out, sp, errs))

        if prev is None or prev.group_enable_mask != cfg.group_enable_mask:
            if put("SetGroupEnableMask", cfg.group_enable_mask):
                reads.append(lambda: self._rd_mask(out, errs))

        if prev is None or prev.trigger_edge != cfg.trigger_edge:
            # Board-wide despite the per-channel signature: setting ch0 then ch1
            # to different values leaves both reading the last one. One write.
            if put("SetTriggerPolarity", ct.c_uint32(0), _EDGE_ENC(cfg.trigger_edge)):
                reads.append(lambda: self._rd_edge(out, errs))

        for gr in range(C.NUM_GROUPS):
            g = cfg.groups[gr]
            pg = prev.groups[gr] if prev is not None else None
            for spec in GROUP_HW:
                attr, _g2, setter, _ct, enc, _d = spec
                if pg is None or getattr(pg, attr) != getattr(g, attr):
                    if put(setter, ct.c_uint32(gr), enc(getattr(g, attr))):
                        reads.append(lambda r=gr, sp=spec: self._rd_group(out, r, sp, errs))

        for ch in range(C.NUM_CHANNELS):
            want = cfg.channels[ch].dc_offset & 0xFFFF
            if prev is None or (prev.channels[ch].dc_offset & 0xFFFF) != want:
                if put("SetChannelDCOffset", ct.c_uint32(ch), want):
                    reads.append(lambda c=ch: self._rd_channel(out, c, errs))

        if not wrote:
            return (cfg if prev is None else prev), errs

        for r in reads:
            r()
        self._state = out
        errs += _diff(cfg, out, skip=self._write_only)
        return out, errs

    def configure(self, cfg):
        """Arm-time setup. Reset wipes the board, so every setting is rewritten
        here; returns (actual config, errors) like write_settings."""
        self._cfg = cfg
        L, h = self._lib, self._h
        self._chk(L.CAEN_DGTZ_Reset(h), "Reset")
        self._state = None      # Reset invalidated everything we knew
        self._chk(L.CAEN_DGTZ_SetAcquisitionMode(h, AcqMode_SW_CONTROLLED), "SetAcquisitionMode")
        actual, errs = self.write_settings(cfg)
        # DRS4 corrections: let the library apply them inside DecodeEvent
        if cfg.correction_level != "disabled":
            self._chk(L.CAEN_DGTZ_LoadDRS4CorrectionData(h, cfg.drs4_frequency),
                      "LoadDRS4CorrectionData")
            self._chk(L.CAEN_DGTZ_EnableDRS4Correction(h), "EnableDRS4Correction")
        # readout buffers
        if self._buf:
            L.CAEN_DGTZ_FreeReadoutBuffer(ct.byref(self._buf))
        self._chk(L.CAEN_DGTZ_MallocReadoutBuffer(h, ct.byref(self._buf), ct.byref(self._buf_size)),
                  "MallocReadoutBuffer")
        self._chk(L.CAEN_DGTZ_AllocateEvent(h, ct.byref(self._evtptr)), "AllocateEvent")
        return actual, errs

    def start(self) -> None:
        self._chk(self._lib.CAEN_DGTZ_SWStartAcquisition(self._h), "SWStartAcquisition")

    def stop(self) -> None:
        self._chk(self._lib.CAEN_DGTZ_SWStopAcquisition(self._h), "SWStopAcquisition")

    def read_events(self) -> list[Event]:
        L, h = self._lib, self._h
        read = ct.c_uint32(0)
        ret = L.CAEN_DGTZ_ReadData(h, 0, self._buf, ct.byref(read))  # 0 = SLAVE_TERMINATED
        self._chk(ret, "ReadData")
        if read.value == 0:
            return []
        n = ct.c_uint32(0)
        self._chk(L.CAEN_DGTZ_GetNumEvents(h, self._buf, read, ct.byref(n)), "GetNumEvents")
        out: list[Event] = []
        info = _EventInfo()
        evtdata = ct.c_char_p()
        for i in range(n.value):
            self._chk(L.CAEN_DGTZ_GetEventInfo(h, self._buf, read, i,
                      ct.byref(info), ct.byref(evtdata)), "GetEventInfo")
            self._chk(L.CAEN_DGTZ_DecodeEvent(h, evtdata, ct.byref(self._evtptr)), "DecodeEvent")
            ev742 = ct.cast(self._evtptr, ct.POINTER(_X742_EVENT)).contents
            samples: dict[int, np.ndarray] = {}
            for gr in range(C.NUM_GROUPS):
                if not ev742.GrPresent[gr]:
                    continue
                group = ev742.DataGroup[gr]
                for ci in range(C.GROUP_SIZE):
                    size = group.ChSize[ci]
                    if size == 0:
                        continue
                    ptr = group.DataChannel[ci]
                    arr = np.ctypeslib.as_array(ptr, shape=(size,)).astype(np.float32).copy()
                    samples[gr * C.GROUP_SIZE + ci] = arr
            out.append(Event(index=info.EventCounter, timestamp_s=0.0,
                             trigger_time_tag=info.TriggerTimeTag, samples=samples))
        return out

    def close(self) -> None:
        if not self._lib:
            return
        try:
            if self._evtptr:
                self._lib.CAEN_DGTZ_FreeEvent(self._h, ct.byref(self._evtptr))
            if self._buf:
                self._lib.CAEN_DGTZ_FreeReadoutBuffer(ct.byref(self._buf))
            self._lib.CAEN_DGTZ_CloseDigitizer(self._h)
        except Exception:
            pass
