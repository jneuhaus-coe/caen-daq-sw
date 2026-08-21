"""Opening the UI, and starting a server to open it against.

The window is only a view: it can be closed and reopened freely, and nothing it
does reaches the acquisition. The server outlives it.
"""
from __future__ import annotations

import os
import shutil
import subprocess
import sys
import time
from typing import Optional

from . import runtime

# Chromium's --app gives a window with no tab strip or address bar, which is what
# makes this feel like an application rather than a web page. Falling back to the
# default browser is not a downgrade worth warning about.
_CHROMIUM_WINDOWS = [
    r"%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe",
    r"%ProgramFiles%\Microsoft\Edge\Application\msedge.exe",
    r"%ProgramFiles%\Google\Chrome\Application\chrome.exe",
    r"%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe",
    r"%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe",
]
_CHROMIUM_POSIX = [
    "google-chrome", "google-chrome-stable", "chromium", "chromium-browser",
    "microsoft-edge", "brave-browser",
]


def _find_chromium() -> Optional[str]:
    if os.name == "nt":
        for raw in _CHROMIUM_WINDOWS:
            path = os.path.expandvars(raw)
            if "%" not in path and os.path.isfile(path):
                return path
        return None
    for name in _CHROMIUM_POSIX:
        found = shutil.which(name)
        if found:
            return found
    return None


# Matches <title> in the UI. Chromium puts the page title on an --app window, so
# this is how an already-open window is recognised.
WINDOW_TITLE = "DT5742B DAQ"


def focus_existing_window(title: str = WINDOW_TITLE) -> bool:
    """Raise an already-open DAQ window. True if one was found.

    Launching another window every time the tray is clicked leaves a pile of
    identical windows and no way to tell which is which.
    """
    if os.name != "nt":
        return False
    try:
        import ctypes
        from ctypes import wintypes

        user32 = ctypes.WinDLL("user32", use_last_error=True)
        proc_type = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
        needle = title.lower()
        found = []

        def visit(hwnd, _lparam):
            if not user32.IsWindowVisible(hwnd):
                return True
            length = user32.GetWindowTextLengthW(hwnd)
            if not length:
                return True
            buf = ctypes.create_unicode_buffer(length + 1)
            user32.GetWindowTextW(hwnd, buf, length + 1)
            if needle in buf.value.lower():
                found.append(hwnd)
                return False                  # stop at the first match
            return True

        user32.EnumWindows(proc_type(visit), 0)
        if not found:
            return False

        hwnd = found[0]
        SW_RESTORE = 9
        if user32.IsIconic(hwnd):
            user32.ShowWindow(hwnd, SW_RESTORE)
        user32.SetForegroundWindow(hwnd)
        return True
    except Exception:
        return False                          # raising a window is never worth an error


def open_ui(url: str, reuse: bool = True) -> str:
    """Show the UI. Returns how it was opened, for the caller to report."""
    if reuse and focus_existing_window():
        return "raised the open window"

    browser = _find_chromium()
    if browser:
        try:
            subprocess.Popen(
                [browser, f"--app={url}", "--new-window"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                start_new_session=(os.name != "nt"),
            )
            return "app window"
        except OSError:
            pass                              # fall through to the plain browser
    import webbrowser
    webbrowser.open(url)
    return "browser"


def _server_argv(host: str, port: int, no_open: bool) -> list:
    argv = [sys.executable, "-m", "daq", "--serve", "--host", host, "--port", str(port)]
    if no_open:
        argv.append("--no-open")
    return argv


def _windowless_python() -> str:
    """pythonw.exe, so the detached server does not park a console window on the
    desktop. Falls back to python.exe, which works but leaves the window."""
    exe = sys.executable
    if os.name == "nt":
        candidate = os.path.join(os.path.dirname(exe), "pythonw.exe")
        if os.path.isfile(candidate):
            return candidate
    return exe


def start_server_detached(host: str, port: int, no_open: bool, tray: bool = True) -> None:
    """Start the server as its own process, outliving this one."""
    argv = _server_argv(host, port, no_open)
    argv[0] = _windowless_python()
    if tray:
        argv.append("--tray")

    kwargs = {"stdout": subprocess.DEVNULL, "stderr": subprocess.DEVNULL,
              "stdin": subprocess.DEVNULL}
    if os.name == "nt":
        # DETACHED_PROCESS keeps it off this console; NEW_PROCESS_GROUP stops a
        # Ctrl-C in the launching terminal from reaching it.
        kwargs["creationflags"] = 0x00000008 | 0x00000200
    else:
        kwargs["start_new_session"] = True
    subprocess.Popen(argv, **kwargs)


def wait_for_server(port: int, timeout: float = 30.0) -> Optional[dict]:
    deadline = time.time() + timeout
    while time.time() < deadline:
        status = runtime.probe(port, timeout=1.0)
        if status is not None:
            return status
        time.sleep(0.25)
    return None
