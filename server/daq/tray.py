"""System-tray icon for the running server (Windows).

The icon is the status you can see from across the room without a window open:
a scope pulse on a chip of colour — grey when no unit is attached, green when it
is, red while a run is recording.

It also owns the only Quit in the product, and that Quit asks first — but only
when a run is actually recording, which is the one moment the answer matters.
"""
from __future__ import annotations

import os
import threading
from typing import Callable, Optional

from . import logsetup

log = logsetup.get("daq.tray")

_GREY = (128, 134, 139)
_GREEN = (61, 174, 99)
_RED = (211, 63, 63)
_TRACE = (255, 255, 255)

_POLL_S = 1.0

# Shell_NotifyIcon's szTip is 128 wchars including the terminator.
_MAX_TITLE = 127


def available() -> bool:
    try:
        import PIL  # noqa: F401
        import pystray  # noqa: F401
    except Exception:
        return False
    return True


def _icon_image(color, size: int = 256):
    """A rounded chip in the status colour with a white scope pulse across it.

    Drawn large and downscaled by the tray, which renders at 16px — every
    proportion here was chosen by looking at it at that size, where a thinner
    stroke turns to mush and a thicker one closes up the peak.
    """
    from PIL import Image, ImageDraw

    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle((10, 10, size - 11, size - 11),
                        radius=int(size * 0.24), fill=color)

    inset = size * 0.15
    x0, x1 = inset, size - inset
    span = x1 - x0
    baseline, peak = size * 0.62, size * 0.26
    d.line([(x0, baseline),
            (x0 + span * 0.28, baseline),
            (x0 + span * 0.40, peak),
            (x0 + span * 0.52, baseline * 0.97),
            (x0 + span * 0.66, baseline),
            (x1, baseline)],
           fill=_TRACE, width=int(size * 0.105), joint="curve")
    return img


def _fit(text: str) -> str:
    """Trim to what a tray tooltip can hold, keeping the end (the event count)."""
    if len(text) <= _MAX_TITLE:
        return text
    return text[:_MAX_TITLE - 1] + "\u2026"


def _summary(status: dict) -> tuple:
    """(colour, one-line description) for the current state."""
    board = status.get("board") or {}
    if not status.get("opened"):
        return _GREY, "No unit connected"

    name = board.get("model") or "DT5742B"
    serial = board.get("serial")
    who = f"{name} S/N {serial}" if serial else name

    if status.get("recording"):
        # A run name can be 60 characters plus a timestamp, which on its own
        # overruns the tooltip buffer - so shorten the name, not the state.
        run = status.get("run_id") or "run"
        events = status.get("recorded") or 0
        tail = f'" \u00b7 {events:,} events'
        room = _MAX_TITLE - len(who) - len(" \u2014 recording \"") - len(tail)
        if room > 8 and len(run) > room:
            run = run[:room - 1] + "\u2026"
        return _RED, _fit(f'{who} \u2014 recording "{run}{tail}')
    if status.get("running"):
        return _GREEN, _fit(f"{who} \u2014 acquiring")
    return _GREEN, _fit(f"{who} \u2014 idle")


def _confirm_quit(run_id: str, events: int) -> bool:
    """Windows message box. Anywhere else, refuse rather than quit unasked."""
    if os.name != "nt":
        return False
    import ctypes
    from ctypes import wintypes

    user32 = ctypes.WinDLL("user32", use_last_error=True)
    user32.MessageBoxW.argtypes = [wintypes.HWND, wintypes.LPCWSTR,
                                   wintypes.LPCWSTR, wintypes.UINT]
    user32.MessageBoxW.restype = ctypes.c_int

    MB_YESNO, MB_ICONWARNING = 0x4, 0x30
    MB_SETFOREGROUND, MB_TOPMOST = 0x10000, 0x40000
    IDYES = 6

    text = (f'A run is recording: "{run_id}" ({events:,} events).\n\n'
            "Stop the run and shut the server down?")
    result = user32.MessageBoxW(
        None, text, "DT5742B DAQ",
        MB_YESNO | MB_ICONWARNING | MB_SETFOREGROUND | MB_TOPMOST)
    return result == IDYES


def _icon_class():
    """pystray shows the menu on right-click only, and left-click invokes the
    default item instead.

    Two separate behaviours on one small target is confusing, and right-clicking
    a tray icon on a laptop touchpad is genuinely awkward — so remap left-click
    to do exactly what right-click does. The backend dispatches through
    `self._on_notify`, looked up per instance, so overriding it is enough.
    """
    import pystray

    if os.name != "nt" or not hasattr(pystray.Icon, "_on_notify"):
        return pystray.Icon

    from pystray._win32 import win32

    class _MenuOnEitherButton(pystray.Icon):
        def _on_notify(self, wparam, lparam):
            if lparam == win32.WM_LBUTTONUP:
                lparam = win32.WM_RBUTTONUP
            return super()._on_notify(wparam, lparam)

    return _MenuOnEitherButton


def _make_menu(text, on_open, on_stop_recording, is_recording, on_quit):
    """The status line IS the open action.

    An "Open" item above a dead label naming what would be opened is two rows
    saying one thing, and the obvious row is the unclickable one. Clicking the
    line that tells you what is connected opens it.
    """
    import pystray

    return pystray.Menu(
        pystray.MenuItem(text, on_open, default=True),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem("Stop recording", on_stop_recording, visible=is_recording),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem("Quit", on_quit),
    )


def run(engine, url: str, shutdown: Callable[[], None],
        open_ui: Optional[Callable[[str], None]] = None) -> None:
    """Show the tray icon and block until the user quits.

    Must be called on the main thread; the server runs in a background thread.
    """
    state = {"status": engine.status(), "text": "", "stop": False, "dialog": False}
    stopping = threading.Event()

    def status() -> dict:
        return state["status"]

    def on_open(icon, item):
        if open_ui:
            open_ui(url)

    def on_stop_recording(icon, item):
        engine.stop_recording()

    def is_recording(item) -> bool:
        return bool(status().get("recording"))

    def on_quit(icon, item):
        s = status()
        if not s.get("recording"):
            state["stop"] = True
            stopping.set()
            icon.stop()
            return

        # Ask on a thread of our own. This callback runs inside the tray's
        # window procedure, and a modal dialog opened there blocks the message
        # pump that the dialog itself needs — the buttons come up dead.
        def ask():
            state["dialog"] = True
            try:
                agreed = _confirm_quit(s.get("run_id") or "run", s.get("recorded") or 0)
            finally:
                state["dialog"] = False
            if agreed:
                engine.stop_recording()
                state["stop"] = True
                stopping.set()
                icon.stop()

        threading.Thread(target=ask, daemon=True).start()

    menu = _make_menu(lambda item: state["text"], on_open,
                      on_stop_recording, is_recording, on_quit)

    colour, text = _summary(state["status"])
    state["text"] = text
    icon = _icon_class()("dt5742b-daq", _icon_image(colour), text, menu)

    def poll():
        last = None
        while not state["stop"]:
            try:
                state["status"] = engine.status()
                colour, text = _summary(state["status"])
                state["text"] = text
                # Never touch the icon or menu while a modal dialog is up: those
                # are cross-thread Win32 calls against a blocked owner thread.
                if not state["dialog"] and (colour, text) != last:
                    icon.icon = _icon_image(colour)
                    icon.title = text
                    icon.update_menu()
                    last = (colour, text)
            except Exception:
                log.debug("tray poll failed", exc_info=True)
            stopping.wait(_POLL_S)

    threading.Thread(target=poll, daemon=True).start()
    icon.run()
    shutdown()
