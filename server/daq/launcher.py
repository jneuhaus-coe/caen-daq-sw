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

from . import logsetup, runtime

log = logsetup.get("daq")

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
        user32.EnumWindows.argtypes = (proc_type, wintypes.LPARAM)
        user32.EnumWindows.restype = wintypes.BOOL
        user32.IsWindowVisible.argtypes = (wintypes.HWND,)
        user32.IsWindowVisible.restype = wintypes.BOOL
        user32.GetWindowTextLengthW.argtypes = (wintypes.HWND,)
        user32.GetWindowTextLengthW.restype = ctypes.c_int
        user32.GetWindowTextW.argtypes = (wintypes.HWND, wintypes.LPWSTR, ctypes.c_int)
        user32.GetWindowTextW.restype = ctypes.c_int
        user32.IsIconic.argtypes = (wintypes.HWND,)
        user32.IsIconic.restype = wintypes.BOOL
        user32.ShowWindow.argtypes = (wintypes.HWND, ctypes.c_int)
        user32.ShowWindow.restype = wintypes.BOOL
        user32.SetForegroundWindow.argtypes = (wintypes.HWND,)
        user32.SetForegroundWindow.restype = wintypes.BOOL

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
    if webbrowser.open(url):
        return "browser"
    # Headless boxes and locked-down desktops have no browser to hand. Saying
    # "browser" here claimed a window that is not there; the URL is the useful
    # thing to report instead.
    return f"no browser could be opened - visit {url}"


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


def start_server_detached(host: str, port: int, no_open: bool,
                          tray: bool = True) -> subprocess.Popen:
    """Start the server as its own process, outliving this one.

    Returns the handle so the caller can tell "still starting" from "died on the
    way up" - otherwise a server that fails immediately looks identical to a
    slow one, for the whole timeout.
    """
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
    return subprocess.Popen(argv, **kwargs)


def wait_for_server(port: int, timeout: float = 30.0, stop=None) -> Optional[dict]:
    """Wait for the server to answer. `stop` lets a caller abandon the wait -
    without it, a Ctrl-C during startup leaves this polling a server that is
    already shutting down, for the full timeout."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        if stop is not None and stop():
            return None
        status = runtime.probe(port, timeout=1.0)
        if status is not None:
            return status
        time.sleep(0.25)
    return None


def _request_shutdown(port: int) -> Optional[int]:
    """POST /api/shutdown. Returns the HTTP status, or None if nothing answered.

    The endpoint closes the digitizer before exiting - the step a kill skips,
    and skipping it is what leaves the CAEN link wedged for the next open.
    """
    import http.client
    import urllib.error
    import urllib.request

    request = urllib.request.Request(f"http://127.0.0.1:{port}/api/shutdown",
                                     method="POST", data=b"")
    try:
        with urllib.request.urlopen(request, timeout=10) as r:
            return r.status
    except urllib.error.HTTPError as e:
        return e.code
    except (urllib.error.URLError, OSError, http.client.HTTPException):
        return None


def stop_server(live: dict, timeout: float = 20.0) -> bool:
    """Stop the server `runtime.find_server()` found, and confirm it is gone.

    Asks it to shut down gracefully first; a server too old to have the
    endpoint is signalled instead. Refuses - returning False with the reason
    logged - when a run is recording, or when the pid cannot be confirmed as
    the server's own. Never kills on a hunch.
    """
    port = live["port"]
    pid = live.get("pid")
    if not pid:
        log.error("The server on port %s did not record its pid; stop it yourself.", port)
        return False
    pid = int(pid)

    # Cross-check the two independent claims about who is on that port: the
    # runtime file, and the server's own answer. The file outlives crashes and
    # pids get recycled, so when they disagree the pid in the file may belong to
    # something else entirely - and on a host with a port forward the server
    # that answered is not even on this machine.
    recorded, reported = live.get("recorded_pid"), live["status"].get("pid")
    if reported is not None and recorded is not None and int(recorded) != int(reported):
        log.error("The runtime record names pid %s, but the server answering on "
                  "port %s says it is pid %s.", recorded, port, reported)
        log.error("That record is stale, or the port reaches a server on another "
                  "machine. Refusing to stop either.")
        log.error("Stop that server where it runs, or delete %s", runtime.runtime_path())
        return False

    with logsetup.step(log, f"Stopping the server (pid {pid} on port {port})") as stopping:
        answer = _request_shutdown(port)
        if answer == 409:
            # The server checks for itself, so a recording that started after
            # we looked is still safe.
            stopping.done("Refused: a run started recording just now")
            return False
        if answer != 200:
            # Older than the endpoint. On Windows os.kill is TerminateProcess,
            # which gives the server no chance to tidy up after itself.
            log.debug("graceful shutdown unavailable (%s); signalling pid %s", answer, pid)
            try:
                os.kill(pid, 15)
            except OSError as e:
                stopping.done(f"Could not signal pid {pid}: {e}")
                return False

        deadline = time.time() + timeout
        while time.time() < deadline and runtime.process_alive(pid):
            time.sleep(0.25)
        if runtime.process_alive(pid):
            stopping.done(f"Still running {timeout:.0f}s later")
            explain_unkillable(pid)
            return False
        runtime.clear()              # a killed server cannot clear its own record

        # The process is gone; the port should be too. If it is not, say so
        # instead of leaving the next start to fail with a bare bind error.
        if not runtime.port_is_free("127.0.0.1", port):
            owner = runtime.port_owner(port)
            stopping.done(f"Stopped, but port {port} is still held by "
                          f"{owner or 'something unidentified'}")
            return False
        stopping.done("Stopped")
    return True


def explain_unkillable(pid: int) -> None:
    """A process that survives a kill is not refusing to stop - it cannot.

    On Windows the kill is TerminateProcess, which does not wait for consent:
    the process only lingers when a thread is blocked in an uninterruptible
    kernel call, and here that is almost always the CAEN USB driver
    (CAENUSBdrv.sys) wedged inside OpenDigitizer. Seen live on serial 53364:
    the open hung in the driver, every kill "succeeded", and the process stayed
    until the unit was power-cycled. Without naming the remedy the operator is
    left kill-looping a process that can never exit on its own.
    """
    log.error("pid %s did not exit after being asked to stop.", pid)
    if os.name == "nt":
        log.error("a process that survives a kill on Windows is stuck in a kernel")
        log.error("driver call - usually the CAEN USB driver wedged mid-open.")
        log.error("power-cycle (or unplug and replug) the digitizer to release it;")
        log.error("if the process still does not exit, reboot the machine.")
