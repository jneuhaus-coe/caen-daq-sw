"""Tray checks. The tray is Windows-only, so on any other platform this exits
without running anything — a Windows CI runner is the only place it has teeth.

It cannot show the icon headlessly, but it can prove the parts that actually
break: the dependencies are installed, the state-to-colour mapping is right, and
the image and menu can be built at all.

Run: `python tests/test_tray.py` from the server/ dir.
"""
import os
import sys

from daq import tray


def test_summary_colours():
    grey, text = tray._summary({"opened": False})
    assert grey == tray._GREY and "No unit" in text

    board = {"model": "DT5742B", "serial": 53364}
    green, text = tray._summary({"opened": True, "board": board})
    assert green == tray._GREEN and "53364" in text and "idle" in text

    green, text = tray._summary({"opened": True, "running": True, "board": board})
    assert green == tray._GREEN and "acquiring" in text

    red, text = tray._summary({"opened": True, "recording": True, "run_id": "run-3",
                               "recorded": 12481, "board": board})
    assert red == tray._RED and '"run-3"' in text and "12,481" in text


def test_icon_image_builds():
    for colour in (tray._GREY, tray._GREEN, tray._RED):
        img = tray._icon_image(colour)
        assert img.size == (256, 256) and img.mode == "RGBA"
        # The tray renders at 16px; the trace has to survive that downscale.
        small = img.resize((16, 16))
        assert small.getbbox() is not None
        assert len({small.getpixel((x, y))[:3] for x in range(16)
                    for y in range(16) if small.getpixel((x, y))[3] > 200}) > 1, \
            "the pulse should still be distinguishable from the chip at 16px"


def test_menu_shape():
    """The status line is the only open action, and Stop recording appears only
    while a run is recording."""
    recording = {"on": False}
    menu = tray._make_menu(
        lambda item: "DT5742B S/N 53364 — idle",
        lambda i, x: None,
        lambda i, x: None,
        lambda item: recording["on"],
        lambda i, x: None,
    )

    labels = [str(i.text) for i in menu]
    assert "Open" not in labels and "Open DAQ" not in labels
    assert labels[0].startswith("DT5742B")
    assert menu.items[0].default, "the status line should be the default item"
    assert "Stop recording" not in labels
    assert labels[-1] == "Quit"

    recording["on"] = True
    labels = [str(i.text) for i in menu]
    assert "Stop recording" in labels


def test_icon_builds_and_left_click_opens_the_menu():
    import pystray

    icon_cls = tray._icon_class()
    assert issubclass(icon_cls, pystray.Icon)
    if os.name == "nt":
        # Must be our subclass, or left-click reverts to invoking the default
        # item instead of showing the menu.
        assert icon_cls is not pystray.Icon, "left-click remap is not in place"
    else:
        assert icon_cls is pystray.Icon

    menu = tray._make_menu(lambda item: "status", lambda i, x: None,
                           lambda i, x: None, lambda item: False,
                           lambda i, x: None)
    icon = icon_cls("dt5742b-daq", tray._icon_image(tray._GREEN), "title", menu)
    assert icon.name == "dt5742b-daq"


if __name__ == "__main__":
    if not tray.available():
        print(f"skipped: no tray support on this platform ({sys.platform})")
        raise SystemExit(0)
    for fn in [test_summary_colours, test_icon_image_builds, test_menu_shape,
               test_icon_builds_and_left_click_opens_the_menu]:
        fn()
        print("ok:", fn.__name__)
    print("ALL TRAY TESTS PASSED")
