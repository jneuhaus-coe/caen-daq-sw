"""Is the digitizer on USB right now? Asked of Windows, never of CAEN's driver.

The CAEN USB driver (CAENUSBdrv.sys 3.4.9) misbehaves when it is called while
the unit is off or still booting: OpenDigitizer then blocks inside the driver
for 24-58 s (once 3m20s, released only by the next power-off) before failing.
Seen on serial 53364, while a raw open on a booted unit takes ~10 ms. An
operator cannot know whether a call is in flight when they flip the switch,
so the fix is to stop making calls at the wrong moments: before any USB open
the backend asks Windows' own device list (cfgmgr32, the Device Manager data)
whether the unit is there and has had time to boot.

Nothing here runs on its own. A scan happens only when gate() is asked -
which the engine does only while the unit is NOT open - and at most once per
USB_POLL_S; between scans the last answer is reused. While connected there
are no scans at all: loss is detected by the backend's own calls failing.

Off Windows (or if cfgmgr32 cannot be queried) gate() answers None and
nothing is gated: the caller behaves exactly as it did before this module.
"""
from __future__ import annotations

import ctypes as ct
import sys
import threading
import time

from . import constants as C
from . import logsetup

log = logsetup.get("daq.usb")

# "CAEN Desktop Waveform Digitizers Carrier" - the DT57xx's USB function. The
# A4818 optical adapter is also VID 0x21E1 but has its own PID, so it does not
# match.
_DEVICE_PREFIX = "USB\\VID_21E1&PID_0000\\"

_CR_SUCCESS = 0
_CM_GETIDLIST_FILTER_ENUMERATOR = 0x00000001
_CM_GETIDLIST_FILTER_PRESENT = 0x00000100
_DN_STARTED = 0x00000008


class _CfgMgr:
    """The four cfgmgr32 calls this needs, with explicit signatures (ctypes'
    default int restype has bitten this project before - see runtime.py)."""

    def __init__(self):
        dll = ct.WinDLL("cfgmgr32")
        ul, pul = ct.c_ulong, ct.POINTER(ct.c_ulong)
        self.size = dll.CM_Get_Device_ID_List_SizeW
        self.size.argtypes = [pul, ct.c_wchar_p, ul]
        self.size.restype = ul
        self.list = dll.CM_Get_Device_ID_ListW
        self.list.argtypes = [ct.c_wchar_p, ct.c_wchar_p, ul, ul]
        self.list.restype = ul
        self.locate = dll.CM_Locate_DevNodeW
        self.locate.argtypes = [pul, ct.c_wchar_p, ul]
        self.locate.restype = ul
        self.status = dll.CM_Get_DevNode_Status
        self.status.argtypes = [pul, pul, ul, ul]
        self.status.restype = ul

    def digitizer_ready(self) -> bool:
        """True if a present DT57xx has a started driver and no problem code."""
        flags = _CM_GETIDLIST_FILTER_ENUMERATOR | _CM_GETIDLIST_FILTER_PRESENT
        # The list can grow between the size call and the fetch (a device
        # arriving), which answers CR_BUFFER_SMALL; a retry settles it.
        for _ in range(3):
            n = ct.c_ulong(0)
            if self.size(ct.byref(n), "USB", flags) != _CR_SUCCESS:
                raise OSError("CM_Get_Device_ID_List_Size failed")
            buf = ct.create_unicode_buffer(n.value + 64)
            if self.list("USB", buf, len(buf), flags) == _CR_SUCCESS:
                break
        else:
            raise OSError("CM_Get_Device_ID_List failed")
        ids = ct.wstring_at(ct.addressof(buf), len(buf)).split("\0")
        for dev_id in ids:
            if not dev_id.upper().startswith(_DEVICE_PREFIX):
                continue
            inst = ct.c_ulong(0)
            if self.locate(ct.byref(inst), dev_id, 0) != _CR_SUCCESS:
                continue        # gone between the list and the lookup
            st, problem = ct.c_ulong(0), ct.c_ulong(0)
            if self.status(ct.byref(st), ct.byref(problem), inst.value, 0) != _CR_SUCCESS:
                continue
            if st.value & _DN_STARTED and problem.value == 0:
                return True
        return False


_lock = threading.Lock()
_cfg: _CfgMgr | None = None
_unavailable = sys.platform != "win32"
_last_scan = float("-inf")
_ready = False
# When the unit was first seen present in its current stretch. -inf means
# "long settled": a unit already there when we first look was there before
# us, not one mid-boot.
_ready_since = float("-inf")
_first_look = True


def _scan_locked(now: float) -> None:
    global _cfg, _unavailable, _last_scan, _ready, _ready_since, _first_look
    if _cfg is None:
        try:
            _cfg = _CfgMgr()
        except Exception as e:
            _unavailable = True
            log.warning("USB device checks unavailable (%s); the driver will "
                        "be called without them", e)
            return
    try:
        ready = _cfg.digitizer_ready()
    except Exception as e:
        log.debug("USB device scan failed (%s); not gating this time", e)
        _last_scan = now
        _ready, _ready_since = True, float("-inf")
        return
    _last_scan = now
    if ready and not _ready:
        _ready_since = float("-inf") if _first_look else now
        if not _first_look:
            log.info("The digitizer is on USB; leaving it %.0fs to boot before "
                     "talking to it", C.USB_SETTLE_S)
    elif _ready and not ready:
        log.info("The digitizer is not on USB (switched off or unplugged)")
    _ready = ready
    _first_look = False


def gate() -> str | None:
    """Why the USB driver must not be called right now, or None if it may be.

    Scans Windows' device list at most once per USB_POLL_S; ask it only while
    the unit is not open."""
    if _unavailable:
        return None
    with _lock:
        now = time.monotonic()
        if now - _last_scan >= C.USB_POLL_S:
            _scan_locked(now)
        if _unavailable:
            return None
        if not _ready:
            return "the unit is not on USB (switched off or unplugged)"
        left = C.USB_SETTLE_S - (now - _ready_since)
        if left > 0:
            return f"the unit just appeared on USB; letting it boot ({left:.0f}s)"
        return None


def unit_lost() -> None:
    """The open unit stopped answering. Whatever is on USB now may be the same
    unit switched off and straight back on, mid-boot - so the next sighting
    starts the settle clock instead of counting as long settled."""
    global _ready, _ready_since, _last_scan, _first_look
    with _lock:
        _ready, _ready_since = False, float("-inf")
        _last_scan = float("-inf")
        _first_look = False
