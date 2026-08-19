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
ConnectionType_USB = 0
AcqMode_SW_CONTROLLED = 0
TriggerMode_DISABLED = 0
TriggerMode_ACQ_ONLY = 1
TriggerMode_ACQ_AND_EXTOUT = 3
# DRS4 frequency enum values (0=5G,1=2.5G,2=1G,3=750M) — match our constants keys.


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

    def configure(self, cfg) -> None:
        self._cfg = cfg
        L, h = self._lib, self._h
        self._chk(L.CAEN_DGTZ_Reset(h), "Reset")
        self._chk(L.CAEN_DGTZ_SetMaxNumEventsBLT(h, cfg.max_events_blt), "SetMaxNumEventsBLT")
        self._chk(L.CAEN_DGTZ_SetAcquisitionMode(h, AcqMode_SW_CONTROLLED), "SetAcquisitionMode")
        # 742-specific: groups + DRS4 frequency + fast trigger
        self._chk(L.CAEN_DGTZ_SetGroupEnableMask(h, cfg.group_enable_mask), "SetGroupEnableMask")
        self._chk(L.CAEN_DGTZ_SetDRS4SamplingFrequency(h, cfg.drs4_frequency), "SetDRS4SamplingFrequency")
        ft = TriggerMode_ACQ_ONLY if cfg.fast_trigger != "disabled" else TriggerMode_DISABLED
        self._chk(L.CAEN_DGTZ_SetFastTriggerDigitizing(h, 1 if cfg.fast_trigger_digitizing else 0),
                  "SetFastTriggerDigitizing")
        self._chk(L.CAEN_DGTZ_SetFastTriggerMode(h, ft), "SetFastTriggerMode")
        ext = {"disabled": TriggerMode_DISABLED, "acquisition_only": TriggerMode_ACQ_ONLY,
               "acq_and_trgout": TriggerMode_ACQ_AND_EXTOUT}[cfg.external_trigger]
        self._chk(L.CAEN_DGTZ_SetExtTriggerInputMode(h, ext), "SetExtTriggerInputMode")
        self._chk(L.CAEN_DGTZ_SetPostTriggerSize(h, cfg.post_trigger), "SetPostTriggerSize")
        trigmode = {"disabled": TriggerMode_DISABLED, "acquisition_only": TriggerMode_ACQ_ONLY,
                    "acq_and_trgout": TriggerMode_ACQ_AND_EXTOUT}
        # per-bank (group) settings
        for gr in range(C.NUM_GROUPS):
            g = cfg.groups[gr]
            if not g.enabled:
                continue
            try:
                L.CAEN_DGTZ_SetGroupSelfTrigger(h, trigmode[g.self_trigger], 1 << gr)
                L.CAEN_DGTZ_SetGroupTriggerThreshold(h, gr, g.trigger_threshold)
                L.CAEN_DGTZ_SetGroupFastTriggerThreshold(h, gr, g.fast_trigger_threshold)
                L.CAEN_DGTZ_SetGroupFastTriggerDCOffset(h, gr, g.fast_trigger_dc_offset)
            except Exception as e:
                raise RuntimeError(f"group {gr} config: {e}")
        # per-channel DC offset
        for ch in range(C.NUM_CHANNELS):
            if cfg.channel_enabled(ch):
                off = cfg.channels[ch].dc_offset & 0xFFFF
                try:
                    L.CAEN_DGTZ_SetChannelDCOffset(h, ch, off)
                except Exception:
                    pass
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
