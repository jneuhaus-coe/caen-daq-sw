"""Tray checks. The tray is Windows-only, so on any other platform this exits
without running anything — a Windows CI runner is the only place it has teeth.

It cannot show the icon headlessly, but it can prove the parts that actually
break: the dependencies are installed, the state-to-colour mapping is right, and
the image and menu can be built at all.

Run: `python tests/test_tray.py` from the server/ dir.
"""
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
        assert img.size == (64, 64) and img.mode == "RGBA"


def test_menu_builds():
    """Constructing the Icon catches a bad pystray API call without showing it."""
    import pystray

    menu = pystray.Menu(
        pystray.MenuItem("Open DAQ", lambda i, x: None, default=True),
        pystray.MenuItem(lambda item: "status line", None, enabled=False),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem("Quit", lambda i, x: None),
    )
    icon = pystray.Icon("dt5742b-daq", tray._icon_image(tray._GREEN), "title", menu)
    assert icon.name == "dt5742b-daq"
    assert len(list(icon.menu)) == 4


if __name__ == "__main__":
    if not tray.available():
        print(f"skipped: no tray support on this platform ({sys.platform})")
        raise SystemExit(0)
    for fn in [test_summary_colours, test_icon_image_builds, test_menu_builds]:
        fn()
        print("ok:", fn.__name__)
    print("ALL TRAY TESTS PASSED")
