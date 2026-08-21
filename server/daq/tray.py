"""System-tray icon for the running server (Windows).

The icon is the status you can see from across the room without a window open:
grey when no unit is attached, green when it is, red while a run is recording.
It also owns the only Quit in the product, and that Quit asks first — but only
when a run is actually recording, which is the one moment the answer matters.
"""
from __future__ import annotations

import os
import threading
from typing import Callable, Optional

_GREY = (128, 134, 139)
_GREEN = (61, 174, 99)
_RED = (211, 63, 63)

_POLL_S = 1.0


def available() -> bool:
    try:
        import PIL  # noqa: F401
        import pystray  # noqa: F401
    except Exception:
        return False
    return True


def _icon_image(color):
    from PIL import Image, ImageDraw

    size = 64
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.ellipse((4, 4, size - 5, size - 5), fill=color)
    return img


def _confirm_quit(run_id: str, events: int) -> bool:
    """Windows message box. Anywhere else, refuse rather than quit unasked."""
    text = (f'A run is recording: "{run_id}" ({events:,} events).\n\n'
            "Stop the run and shut the server down?")
    if os.name != "nt":
        return False
    import ctypes

    MB_YESNO, MB_ICONWARNING, MB_TOPMOST, IDYES = 0x4, 0x30, 0x40000, 6
    result = ctypes.windll.user32.MessageBoxW(
        0, text, "DT5742B DAQ", MB_YESNO | MB_ICONWARNING | MB_TOPMOST)
    return result == IDYES


def _summary(status: dict) -> tuple:
    """(colour, one-line description) for the current state."""
    board = status.get("board") or {}
    if not status.get("opened"):
        return _GREY, "No unit connected"

    name = board.get("model") or "DT5742B"
    serial = board.get("serial")
    who = f"{name} S/N {serial}" if serial else name

    if status.get("recording"):
        run = status.get("run_id") or "run"
        events = status.get("recorded") or 0
        return _RED, f'{who} — recording "{run}" · {events:,} events'
    if status.get("running"):
        return _GREEN, f"{who} — acquiring"
    return _GREEN, f"{who} — idle"


def run(engine, url: str, shutdown: Callable[[], None],
        open_ui: Optional[Callable[[str], None]] = None) -> None:
    """Show the tray icon and block until the user quits.

    Must be called on the main thread; the server runs in a background thread.
    """
    import pystray

    state = {"status": engine.status(), "text": "", "stop": False}

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
        if s.get("recording"):
            if not _confirm_quit(s.get("run_id") or "run", s.get("recorded") or 0):
                return
            engine.stop_recording()
        state["stop"] = True
        icon.stop()

    menu = pystray.Menu(
        pystray.MenuItem("Open DAQ", on_open, default=True),
        pystray.MenuItem(lambda item: state["text"], None, enabled=False),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem("Stop recording", on_stop_recording, visible=is_recording),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem("Quit", on_quit),
    )

    colour, text = _summary(state["status"])
    state["text"] = text
    icon = pystray.Icon("dt5742b-daq", _icon_image(colour), text, menu)

    def poll():
        last = None
        while not state["stop"]:
            try:
                state["status"] = engine.status()
                colour, text = _summary(state["status"])
                state["text"] = text
                if (colour, text) != last:
                    icon.icon = _icon_image(colour)
                    icon.title = text
                    icon.update_menu()
                    last = (colour, text)
            except Exception:
                pass          # a poll failure must never take the tray down
            threading.Event().wait(_POLL_S)

    threading.Thread(target=poll, daemon=True).start()
    icon.run()
    shutdown()
