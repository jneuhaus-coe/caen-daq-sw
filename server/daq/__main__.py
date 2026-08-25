from __future__ import annotations

import argparse
import errno
import os
import signal
import sys
import threading
import time

import uvicorn

from . import __version__, launcher, logsetup, runtime
from .acquisition import AcquisitionEngine
from .backend.base import make_backend
from .server import create_app


log = logsetup.get("daq")


def _err(msg: str) -> None:
    log.error(msg)


def _say(msg: str) -> None:
    log.info(msg)


def _check_bindable(host: str, port: int) -> None:
    """Explain a bind failure instead of leaving uvicorn's bare OSError.

    Windows answers EACCES — not EADDRINUSE — when a port falls inside a range
    reserved by Hyper-V or WSL, and that needs a different fix from a port that
    is merely taken, so the two are worth telling apart.
    """
    e = runtime.bind_probe(host, port)
    if e is None:
        return

    if e.errno == errno.EADDRINUSE:
        _err(f"port {port} is already in use. Looking up what holds it...")
        owner = runtime.port_owner(port)
        if owner:
            _err(f"it is held by {owner}.")
        else:
            _err("could not identify what is holding it.")
        _err("stop that process, or start this one elsewhere: daq --port 9100")
    elif e.errno in (errno.EACCES, errno.EPERM):
        _err(f"not allowed to bind {host}:{port}.")
        if os.name == "nt":
            _err("on Windows this usually means the port sits inside a range reserved")
            _err("by Hyper-V or WSL. List the reserved ranges with:")
            _err("    netsh interface ipv4 show excludedportrange protocol=tcp")
            _err("then pick a port outside them: daq --port 9100")
        elif port < 1024:
            _err("ports below 1024 need root. Use the default 8800, or any port above 1024.")
    else:
        _err(f"cannot bind {host}:{port}: {e}")
    raise SystemExit(2)


# How long startup waits for the digitizer before bringing the UI up anyway.
# Opening it loads the DRS4 correction tables, and there is no reason the web UI
# should be unreachable while that happens — it renders a disconnected badge
# perfectly well, and the badge turns green by itself when the open completes.
BOARD_OPEN_WAIT_S = 5.0


def _open_board_in_background(engine, wait_s: float) -> threading.Thread:
    """Start opening the digitizer on a worker; wait a little, then carry on."""
    board_log = logsetup.get("daq.board")

    def work():
        # engine.open() logs the transaction itself, so this only has to report
        # the outcome the operator cares about.
        try:
            engine.open()
        except Exception:
            # The step above already logged what failed and why; say only what
            # it means from here.
            board_log.info("No unit at startup; the UI will show it disconnected "
                           "and keep retrying on its own")

    thread = threading.Thread(target=work, name="board-open", daemon=True)
    thread.start()
    thread.join(wait_s)
    if thread.is_alive():
        board_log.info("Still opening after %.0fs; bringing the UI up now, it "
                       "will connect on its own", wait_s)
    return thread


class _ThreadedServer(uvicorn.Server):
    """For the tray case only, where the server runs off the main thread.

    uvicorn installs signal handlers, which only works on the main thread — and
    there the main thread belongs to the tray. Do NOT use this in the foreground
    `--serve` case: it would leave SIGTERM at its default disposition, so
    systemd's stop would kill the process outright, skipping the graceful
    shutdown and leaving the runtime file behind.
    """

    def install_signal_handlers(self) -> None:
        pass


def _install_shutdown_handler(server) -> None:
    """Stop cleanly on SIGINT/SIGTERM, and always stop on the second one.

    An earlier version re-raised the signal to its default disposition, to keep
    the process reporting "killed by SIGTERM". That was fragile and left Ctrl-C
    hanging: uvicorn re-raises the captured signal into whatever handler was
    installed before it, so ours ran *after* uvicorn had already unwound, and
    re-killing from there depends on platform behaviour that does not hold
    everywhere. Exiting normally is just as clean for systemd - `on-failure`
    does not restart on exit 0 any more than it does on SIGTERM.

    The second signal is the important part: whatever is wedged, a second Ctrl-C
    must always end the process rather than leave a console sitting there.
    """
    state = {"stopping": False}

    def handler(signum, _frame):
        name = signal.Signals(signum).name
        if state["stopping"]:
            log.warning("%s again, exiting immediately", name)
            runtime.clear()
            os._exit(1)
        state["stopping"] = True
        log.info("%s received, shutting down", name)
        server.should_exit = True        # ask uvicorn to unwind if it has not
        runtime.clear()
        # Deliberately no re-raise: returning lets run() finish, the finally
        # below tidy up, and the process exit 0 on its own.

    for sig in (signal.SIGTERM, signal.SIGINT):
        try:
            signal.signal(sig, handler)
        except (ValueError, OSError):
            pass                     # not the main thread, or unsupported here


def _serve(args, with_tray: bool) -> int:
    """Run the server. Blocks until it is shut down."""
    log.info("Starting dt5742b-daq %s (pid %d) on %s:%s...",
             __version__, os.getpid(), args.host, args.port)
    log.debug("python %s from %s", sys.version.split()[0], sys.executable)

    _check_bindable(args.host, args.port)
    logsetup.did(log, f"Checking port {args.port} is free", "Ok")

    # DAQ_BACKEND=fake runs against the synthetic board - for the UI test
    # suite and demos, never the default, and loud when it is in effect so a
    # beamline shift can not mistake synthetic data for the real thing.
    backend_kind = os.environ.get("DAQ_BACKEND", "caen")
    if backend_kind != "caen":
        log.warning("DAQ_BACKEND=%s: this is NOT real hardware", backend_kind)
    engine = AcquisitionEngine(lambda: make_backend(backend_kind))
    if not args.no_open:
        _open_board_in_background(engine, BOARD_OPEN_WAIT_S)
    else:
        log.info("Not opening the digitizer (--no-open); it opens on first Start")

    app = create_app(engine)
    url = runtime.url_for(args.host, args.port)
    log.info("Serving the UI at %s", url)

    # Bound the graceful shutdown. Measured at ~0.5s with a client on the
    # telemetry socket, so this never bites in practice — but uvicorn's default
    # is to wait forever, and one wedged connection would be enough to make
    # `daq stop` and the installer's shutdown hang with no way to tell why.
    config = uvicorn.Config(app, host=args.host, port=args.port,
                            log_config=None,          # keep our handlers
                            access_log=False,         # a request is not a transaction
                            timeout_graceful_shutdown=10)
    server = _ThreadedServer(config) if with_tray else uvicorn.Server(config)

    runtime.write(args.host, args.port)
    log.debug("runtime record written to %s", runtime.runtime_path())
    _install_shutdown_handler(server)
    if with_tray:
        from . import tray as _tray
        if not _tray.available():
            # Only the launcher passes --tray, and only when it is available -
            # but crashing with an import traceback is no way to find that out.
            log.warning("no tray support here (pystray is Windows-only); "
                        "serving without one")
            with_tray = False

    try:
        if with_tray:
            thread = threading.Thread(target=server.run, daemon=True)
            thread.start()
            if launcher.wait_for_server(
                    args.port, stop=lambda: server.should_exit) is None:
                # A tray icon for a server that never came up is worse than no
                # tray: it says "running" while nothing answers, and whatever
                # went wrong stays invisible.
                _err(f"the server did not come up on {args.host}:{args.port}.")
                _err("run 'daq --serve' in a terminal to see the error.")
                return 1
            from . import tray
            log.info("Ready - running in the tray until you quit it")
            tray.run(engine, url,
                     shutdown=lambda: setattr(server, "should_exit", True),
                     open_ui=launcher.open_ui)
            thread.join(timeout=10)
        else:
            log.info("Ready - press Ctrl-C to stop")
            server.run()
    finally:
        with logsetup.step(log, "Shutting down") as stopping:
            runtime.clear()
            try:
                engine.close()
            except Exception as e:
                log.warning("%sThe digitizer would not close cleanly: %s", "  ", e)
            stopping.done("Stopped")
    return 0


def _launch(args) -> int:
    """Attach to a running server if there is one; otherwise start it."""
    with logsetup.step(log, "Looking for a server already running") as looking:
        live = runtime.find_server()
        if live is None:
            # The runtime record can go missing - a crash, a cleaned state
            # directory, an older server that never wrote one. Ask the port
            # itself before concluding nothing is there, or we would start a
            # second server on top of a live one.
            if runtime.probe(args.port) is not None:
                live = {"url": runtime.url_for(args.host, args.port),
                        "version": __version__}
        looking.done(f"Found one at {live['url']}" if live else "No server running")

    if live:
        if live.get("version") != __version__:
            log.warning("the running server is %s, this command is %s - "
                        "restart it to pick up the update",
                        live.get("version"), __version__)
        logsetup.did(log, "Opening a window on it", launcher.open_ui(live["url"]))
        return 0

    # Windows gets a tray icon, so the server can detach and this command can
    # return. Without one there would be no way to see or stop it, so elsewhere
    # it stays in the foreground and Ctrl-C ends it.
    from . import tray
    url = runtime.url_for(args.host, args.port)

    if os.name == "nt" and tray.available():
        # Check here as well as in the server: spawning a detached process only
        # to have it fail invisibly is worth one cheap test to avoid.
        _check_bindable(args.host, args.port)
        logsetup.did(log, f"Checking port {args.port} is free", "Ok")
        with logsetup.step(log, "Starting the server in the background") as starting:
            proc = launcher.start_server_detached(args.host, args.port,
                                                  args.no_open, tray=True)
            if not _wait_for_detached(proc, args.port):
                starting.done("The server did not start")
                _report_failed_start(proc)
                return 1
            starting.done(f"Server running as pid {proc.pid}")
        logsetup.did(log, f"Opening the DAQ at {url}", launcher.open_ui(url))
        log.info("It keeps running in the tray after this window closes")
        return 0

    threading.Timer(1.5, launcher.open_ui, args=(url,)).start()
    return _serve(args, with_tray=False)


def _wait_for_detached(proc, port: int, timeout: float = 30.0) -> bool:
    """Wait for the detached server to answer, saying so while it happens.

    Silence here was indistinguishable from a hang: the command sat for the
    whole timeout with no output whatever the server was doing.
    """
    deadline = time.monotonic() + timeout
    announced = 0.0
    while time.monotonic() < deadline:
        if proc.poll() is not None:
            log.error("The server process exited immediately (code %s)", proc.returncode)
            return False
        if runtime.probe(port, timeout=1.0) is not None:
            return True
        waited = timeout - (deadline - time.monotonic())
        if waited - announced >= 3.0:
            announced = waited
            log.info("%sStill waiting for the server...", "  ")
        time.sleep(0.25)
    log.error("The server did not answer on port %s within %.0fs", port, timeout)
    return False


def _report_failed_start(proc) -> None:
    """The detached server writes nowhere this console can see, so say where to
    look rather than leaving the operator with a bare failure."""
    path = logsetup.active_log_path()
    if path:
        log.error("Its log is at %s", path)
    log.error("Run 'daq --serve' in this window to watch it start")


def _stop(_args) -> int:
    live = runtime.find_server()
    if not live:
        _say("no server is running.")
        return 0
    status = live["status"]
    if status.get("recording"):
        _err(f'a run is recording: "{status.get("run_id")}". '
             "Stop the recording first, or use the tray.")
        return 1

    pid = live.get("pid")
    port = live["port"]
    if not pid:
        _err("the running server did not record its pid; stop it yourself.")
        return 1
    pid = int(pid)
    try:
        os.kill(pid, 15)
    except OSError as e:
        _err(f"could not stop pid {pid}: {e}")
        return 1

    # Confirm rather than assume. On Windows os.kill is TerminateProcess, which
    # is immediate but gives the server no chance to tidy up after itself — so
    # clearing the runtime record is this command's job, not the server's.
    deadline = time.time() + 15
    while time.time() < deadline and runtime.process_alive(pid):
        time.sleep(0.25)
    if runtime.process_alive(pid):
        _explain_unkillable(pid)
        return 1

    runtime.clear()

    # The process is gone; the port should be too. If it is not, say so plainly
    # instead of leaving the next `daq` to fail with an unexplained bind error.
    if not runtime.port_is_free("127.0.0.1", port):
        _say(f"stopped pid {pid}, but port {port} is still in use.")
        owner = runtime.port_owner(port)
        if owner:
            _err(f"port {port} is held by {owner}.")
        else:
            _err(f"could not identify what is holding port {port}.")
        return 1

    _say(f"stopped the server on port {port}.")
    return 0


def _explain_unkillable(pid: int) -> None:
    """A process that survives a kill is not refusing to stop - it cannot.

    On Windows the kill above is TerminateProcess, which does not wait for
    consent: the process only lingers when a thread is blocked in an
    uninterruptible kernel call, and here that is almost always the CAEN USB
    driver (CAENUSBdrv.sys) wedged inside OpenDigitizer. Seen live on serial
    53364: the open hung in the driver, every kill "succeeded", and the process
    stayed until the unit was power-cycled. Without naming the remedy the
    operator is left kill-looping a process that can never exit on its own.
    """
    _err(f"pid {pid} is still running 15s after being asked to stop.")
    if os.name == "nt":
        _err("a process that survives a kill on Windows is stuck in a kernel")
        _err("driver call - usually the CAEN USB driver wedged mid-open.")
        _err("power-cycle (or unplug and replug) the digitizer to release it;")
        _err("if the process still does not exit, reboot the machine.")


def _status(_args) -> int:
    live = runtime.find_server()
    if not live:
        _say("no server is running.")
        return 1
    s = live["status"]
    board = s.get("board") or {}
    _say(f"{live['url']}  (version {live['version']}, pid {live.get('pid')})")
    if s.get("opened"):
        _say(f"unit: {board.get('model')} S/N {board.get('serial')}")
    else:
        _say("unit: not connected")
    if s.get("recording"):
        _say(f'recording "{s.get("run_id")}" - {s.get("recorded") or 0:,} events')
    else:
        _say("acquiring" if s.get("running") else "idle")
    # Report the server's own log file, not where this command would write one:
    # they differ whenever the server was started with different options, or is
    # an older build entirely.
    server_log = s.get("log_file")
    if server_log:
        missing = "" if os.path.exists(server_log) else "   (file not found)"
        _say(f"log: {server_log}{missing}")
    else:
        _say("log: the running server is not writing one")
    return 0


def main():
    p = argparse.ArgumentParser(
        prog="daq",
        description="DT5742B DAQ. With no arguments, opens the UI — attaching to "
                    "a server that is already running, or starting one.")
    p.add_argument("command", nargs="?", choices=["stop", "status"],
                   help="stop or inspect the running server")
    p.add_argument("--version", action="version", version=f"dt5742b-daq {__version__}")
    p.add_argument("--host", default="127.0.0.1",
                   help="address to serve on (default: %(default)s; "
                        "use 0.0.0.0 to reach it from other machines)")
    p.add_argument("--port", type=int, default=8800,
                   help="port to serve on (default: %(default)s)")
    p.add_argument("--serve", action="store_true",
                   help="run the server in the foreground with no window and no "
                        "tray icon; it never exits on its own")
    p.add_argument("--tray", action="store_true",
                   help=argparse.SUPPRESS)     # internal: used by the detached server
    p.add_argument("--open", metavar="URL",
                   help="open a window onto an existing server and exit, starting nothing")
    p.add_argument("--no-open", action="store_true",
                   help="do not open the board at startup (open on first Start)")
    p.add_argument("--log-level", default="info", choices=logsetup.LEVELS,
                   help="console detail (default: %(default)s); the log file "
                        "always records everything")
    p.add_argument("--log-file", metavar="PATH",
                   help=f"where to write the log (default: {logsetup.default_log_path()})")
    p.add_argument("--no-log-file", action="store_true",
                   help="console only, write no log file")
    args = p.parse_args()

    path = logsetup.configure(level=args.log_level, log_file=args.log_file,
                              to_file=not args.no_log_file)
    if path:
        log.debug("logging to %s", path)

    if args.command == "stop":
        return _stop(args)
    if args.command == "status":
        return _status(args)
    if args.open:
        launcher.open_ui(args.open)
        return 0
    if args.serve:
        return _serve(args, with_tray=args.tray)
    return _launch(args)


if __name__ == "__main__":
    sys.exit(main() or 0)
