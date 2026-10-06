"""`daq update`: move to the newest published release and carry on.

The install itself is the release's own installer script, run exactly as the
documented one-liner would run it. That script already carries every lesson
about installing this package (managed Python, retries, judging the result by
what is on disk, finding a server by executable path on Windows), so this
module only decides WHETHER to update, stops the server cleanly, and hands over.

The hand-over differs by platform because a running program cannot replace
itself on Windows: there the installer runs in its own console window after
this process has exited, and on POSIX this process simply becomes the installer.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import tempfile
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Optional

from . import __version__, launcher, logsetup, runtime

log = logsetup.get("daq")

REPO = "jneuhaus-coe/caen-daq-sw"
LATEST_URL = f"https://api.github.com/repos/{REPO}/releases/latest"
# Points the check at a mirror, or at a local stand-in when testing the update
# path end to end without publishing a release.
URL_ENV = "DAQ_UPDATE_URL"

_TIMEOUT_S = 15


class UpdateError(Exception):
    """The update could not proceed; the message says why, for an operator."""


@dataclass
class Release:
    version: str               # "0.12.0"
    tag: str                   # "v0.12.0"
    wheel: Optional[str]       # download URL of the wheel
    installer: Optional[str]   # download URL of this platform's install script


_VERSION_RE = re.compile(r"^v?(\d+)\.(\d+)\.(\d+)(?:(a|b|rc)(\d+))?$")
_PRE_RANK = {"a": 0, "b": 1, "rc": 2}


def version_key(version: str) -> tuple:
    """Sort key for the versions release.sh accepts: 0.2.0, 0.2.0rc1, v0.2.0.

    A pre-release sorts before its final release. Anything else is refused
    rather than guessed at - comparing a version we cannot read would make an
    update decision on noise.
    """
    m = _VERSION_RE.match(version.strip())
    if not m:
        raise UpdateError(f"cannot read the version {version!r}")
    major, minor, patch, pre, pre_n = m.groups()
    pre_part = (_PRE_RANK[pre], int(pre_n)) if pre else (3, 0)
    return (int(major), int(minor), int(patch), pre_part)


def _installer_name() -> str:
    return "install.ps1" if os.name == "nt" else "install.sh"


def latest_release() -> Release:
    """Ask GitHub for the newest published release."""
    url = os.environ.get(URL_ENV) or LATEST_URL
    request = urllib.request.Request(url, headers={
        "Accept": "application/vnd.github+json",
        "User-Agent": f"dt5742b-daq/{__version__}",   # GitHub refuses requests without one
    })
    try:
        with urllib.request.urlopen(request, timeout=_TIMEOUT_S) as r:
            payload = json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        if e.code == 404:
            raise UpdateError("no release has been published yet") from None
        if e.code in (403, 429) and e.headers.get("X-RateLimit-Remaining") == "0":
            raise UpdateError("GitHub's rate limit for this network is used up; "
                              "try again in an hour") from None
        raise UpdateError(f"GitHub answered {e.code} {e.reason}") from None
    except (urllib.error.URLError, OSError) as e:
        reason = getattr(e, "reason", e)
        raise UpdateError(f"could not reach GitHub ({reason})") from None
    except ValueError:
        raise UpdateError("GitHub's answer was not readable") from None

    tag = str(payload.get("tag_name") or "")
    if not tag:
        raise UpdateError("the latest release has no tag")
    assets = {a.get("name", ""): a.get("browser_download_url")
              for a in payload.get("assets") or [] if isinstance(a, dict)}
    wheel = next((u for n, u in assets.items() if n.endswith(".whl")), None)
    return Release(version=tag.lstrip("v"), tag=tag, wheel=wheel,
                   installer=assets.get(_installer_name()))


def _download(url: str, dest: str) -> None:
    request = urllib.request.Request(url, headers={"User-Agent": f"dt5742b-daq/{__version__}"})
    try:
        with urllib.request.urlopen(request, timeout=_TIMEOUT_S) as r, open(dest, "wb") as f:
            shutil.copyfileobj(r, f)
    except (urllib.error.URLError, OSError) as e:
        raise UpdateError(f"could not download {url}: {getattr(e, 'reason', e)}") from None


def _relaunch_args(record: dict) -> Optional[list]:
    """The `daq` arguments that bring the stopped server back as it was, or
    None when it is not ours to restart.

    A server started with an explicit `daq --serve` belongs to whoever started
    it - a systemd unit, NSSM, or someone's terminal - and starting a copy from
    here would leave two owners of one port, or a server tied to this console.
    """
    mode = record.get("mode")
    if mode is None:
        # A server from before the record carried its mode. The detached
        # Windows server is the one that runs under pythonw.exe.
        exe = re.split(r"[\\/]", str(record.get("executable") or ""))[-1].lower()
        mode = "tray" if exe.startswith("pythonw") else "serve"
    if mode not in ("tray", "launcher"):
        return None
    args = ["--host", str(record.get("host") or "127.0.0.1"),
            "--port", str(record.get("port"))]
    if record.get("no_open"):
        args.append("--no-open")
    return args


def windows_wrapper(installer: str, linger_s: int = 6) -> str:
    """The PowerShell that runs the installer in its own console window.

    It closes itself after a success, once there has been a moment to read
    the result; after a failure it stays open until Enter, because the
    message is the one thing the operator needs and a vanishing window takes
    it with it.
    """
    quoted = installer.replace("'", "''")
    return (
        "$Host.UI.RawUI.WindowTitle = 'DT5742B DAQ update'; "
        f"try {{ & '{quoted}'; Write-Host ''; "
        f"Write-Host 'This window closes in a few seconds.'; Start-Sleep -Seconds {linger_s} }} "
        "catch { Write-Host ''; "
        "Read-Host 'The update did not finish. Press Enter to close' | Out-Null; exit 1 }")


def _hand_over(release: Release, installer: str, relaunch: Optional[list]) -> int:
    """Run the release's installer for this release. Does not return on POSIX."""
    env = dict(os.environ)
    env["DAQ_VERSION"] = release.tag
    env["DAQ_WHEEL"] = release.wheel or ""
    if relaunch:
        env["DAQ_RELAUNCH"] = " ".join(relaunch)
    else:
        env.pop("DAQ_RELAUNCH", None)

    if os.name != "nt":
        # Become the installer. Nothing of ours keeps running, so uv is free to
        # replace every file of this install, and the installer's output lands
        # in this terminal as one continuous account.
        log.info("Handing over to the %s installer", release.version)
        os.execve("/bin/bash", ["bash", installer], env)

    # Windows will not replace files a running process holds, and this process
    # runs from the very environment uv must replace. So the installer gets a
    # console of its own, waits for this process to exit, and does the work.
    env["DAQ_WAIT_PID"] = str(os.getpid())
    powershell = (shutil.which("powershell")
                  or os.path.expandvars(r"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"))
    CREATE_NEW_CONSOLE = 0x00000010
    try:
        subprocess.Popen([powershell, "-NoProfile", "-ExecutionPolicy", "Bypass",
                          "-Command", windows_wrapper(installer)],
                         env=env, creationflags=CREATE_NEW_CONSOLE, close_fds=True)
    except OSError as e:
        log.error("Could not start the installer: %s", e)
        if relaunch:
            log.error("Nothing was installed. Start the DAQ again with: daq")
        return 1
    log.info("The update continues in its own window%s",
             "; the DAQ reopens when it finishes" if relaunch else "")
    return 0


def run(check_only: bool = False) -> int:
    """`daq update` (and `daq update --check`). Returns the exit code."""
    with logsetup.step(log, "Checking for updates") as checking:
        try:
            latest = latest_release()
            newer = version_key(latest.version) > version_key(__version__)
            same = version_key(latest.version) == version_key(__version__)
        except UpdateError as e:
            checking.done(f"Could not check: {e}")
            return 1
        if same:
            checking.done(f"Already on the latest release ({__version__})")
            return 0
        if not newer:
            checking.done(f"This build ({__version__}) is newer than the latest "
                          f"release ({latest.version})")
            return 0
        checking.done(f"Update available: {latest.version} (installed: {__version__})")

    if check_only:
        log.info("Run 'daq update' to install it")
        return 0
    if not latest.wheel or not latest.installer:
        missing = "wheel" if not latest.wheel else _installer_name()
        log.error("Release %s has no %s attached, so it cannot be installed from here",
                  latest.tag, missing)
        return 1

    # Fetch the installer BEFORE stopping anything: a download that fails must
    # leave the operator exactly where they were, server and all.
    workdir = tempfile.mkdtemp(prefix="daq-update-")
    installer = os.path.join(workdir, _installer_name())
    try:
        _download(latest.installer, installer)
    except UpdateError as e:
        log.error("%s", e)
        return 1
    logsetup.did(log, f"Fetching the {latest.version} installer", "Ok")

    relaunch = None
    live = runtime.find_server()
    if live:
        status = live["status"]
        if status.get("recording"):
            log.error('A run is recording: "%s". The update will not interrupt it.',
                      status.get("run_id"))
            log.error("Stop the recording, then run 'daq update' again.")
            return 1
        record = runtime.read() or {}
        if not launcher.stop_server(live):
            log.error("The update was not installed.")
            return 1
        relaunch = _relaunch_args(record)
        if relaunch is None:
            log.info("The server was started with 'daq --serve' (a service or a "
                     "terminal); start it again the same way once the update finishes")

    return _hand_over(latest, installer, relaunch)
