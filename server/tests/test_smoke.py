"""Hardware-free smoke tests. Run: `python -m pytest` or
`python tests/test_smoke.py` from the server/ dir.

These cover the config tiers, the aggregation math, the HTTP surface, and the
runtime record the launcher uses to find a running server.
The acquisition loop itself needs the board and is not covered here."""
import json
import os
import tempfile
import time
import numpy as np
from fastapi.testclient import TestClient

from daq.acquisition import AcquisitionEngine
from daq.config import default_config, BoardConfig
from daq.stats import RollingAverage, TriggerRateMeter, decimate
from daq.server import create_app
from daq import constants as C
from daq import runtime


def _refuse_hardware():
    raise RuntimeError("no unit: this test must never touch hardware")


def _engine_without_a_unit() -> AcquisitionEngine:
    """An engine whose every open fails, exactly like a machine with no board.

    The default factory loads the real libCAENDigitizer, so on a machine with a
    unit attached these "hardware-free" tests would open — or hang on — actual
    hardware. Discovered the hard way: a wedged CAEN USB driver left this suite
    blocked inside OpenDigitizer with no output at all.
    """
    return AcquisitionEngine(backend_factory=_refuse_hardware)


def test_tiers_and_enable_is_per_group():
    cfg = default_config()
    assert cfg.groups[0].enabled and not cfg.groups[1].enabled
    assert cfg.enabled_channels() == list(range(0, 8))
    assert cfg.group_enable_mask == 0b01
    cfg.channels[0].dc_offset = 1234
    cfg.channels[3].name = "Upstream"
    cfg2 = BoardConfig.from_dict(cfg.to_dict())          # survives a round trip
    assert cfg2.channels[0].dc_offset == 1234
    assert cfg2.channels[3].name == "Upstream"
    assert cfg2.groups[0].enabled


def test_rolling_average_matches_numpy():
    avg = RollingAverage(window_s=10.0)
    now = time.monotonic()
    waves = [np.full(8, k, dtype=np.float32) for k in (10, 20, 30)]
    for w in waves:
        avg.add(0, w, t=now)  # all within the (real-clock) window
    mean, count = avg.snapshot(0)
    assert count == 3 and np.allclose(mean, np.mean(waves, axis=0))


def test_decimate():
    w = np.arange(1024, dtype=np.float32)
    assert len(decimate(w, 256)) == 256
    assert len(decimate(np.arange(100.0), 256)) == 100  # shorter than target


def test_http_api():
    from fastapi.testclient import TestClient
    # constructing the engine does not touch hardware; opening it would
    c = TestClient(create_app(_engine_without_a_unit()))
    cat = c.get("/api/catalog").json()
    assert cat["bank"]  # bank tier present
    unit = {d["key"]: d for d in cat["unit"]}
    assert {"software_trigger", "io_level", "gpo_output"} <= unit.keys()
    # The UI's required/optional split and its pin-to-default checkboxes hang
    # off these fields; a catalog without them renders every setting required.
    assert unit["drs4_frequency"].get("required") is True
    assert unit["max_events_blt"]["default"] == 1023
    assert unit["io_level"]["default"] == "nim"
    st = c.get("/api/status").json()
    assert st["backend"] == "caen" and st["opened"] is False


def test_config_write_is_refused_with_no_unit():
    """With nothing attached the write goes nowhere, so it must be reported as
    a failure and must not change the stored config. Claiming success here once
    produced a green 'applied and read back from unit' toast with no unit."""
    from fastapi.testclient import TestClient
    c = TestClient(create_app(_engine_without_a_unit()))
    cfg = c.get("/api/config").json()
    was = cfg["channels"][0]["dc_offset"]

    cfg["channels"][0]["dc_offset"] = 555
    r = c.post("/api/config", json=cfg).json()
    assert r["connected"] is False
    assert r["ok"] is False and r["errors"]
    assert r["config"]["channels"][0]["dc_offset"] == was       # reverts
    assert c.get("/api/config").json()["channels"][0]["dc_offset"] == was


def test_rate_meter_total_and_last_bucket():
    """Count is a per-run total, and the headline rate is the last COMPLETE
    bucket — the still-filling one always reads low."""
    m = TriggerRateMeter(bin_s=0.05, window_s=0.5)
    for _ in range(3):
        m.add(4)
        time.sleep(0.06)
    snap = m.snapshot()
    assert snap["total"] == 12                       # cumulative, not windowed
    assert snap["instant"] == snap["rate"][-1]       # matches the last bar drawn
    assert len(snap["rate"]) == m.nbins - 1          # partial bin excluded
    m.reset()
    snap = m.snapshot()
    assert snap["total"] == 0 and all(v == 0 for v in snap["rate"])
    m.add(7)
    assert m.snapshot()["total"] == 7                # counts up again


def test_probe_and_reconnect_without_hardware():
    """No board attached: probing and reconnecting must report disconnected
    rather than raising, so the UI can render a red badge."""
    eng = _engine_without_a_unit()
    assert eng.probe() is False
    assert eng.status()["opened"] is False
    assert eng.reconnect()["opened"] is False
    c = TestClient(create_app(eng))
    assert c.get("/api/status").json()["opened"] is False
    assert c.post("/api/board/reconnect").json()["opened"] is False


def test_software_trigger_is_refused_with_no_unit():
    """No unit means nothing can fire: the request must be refused, not queued
    for an acquisition that can never start."""
    c = TestClient(create_app(_engine_without_a_unit()))
    r = c.post("/api/trigger", json={"count": 100, "rate_hz": 50}).json()
    assert r["ok"] is False
    assert r["status"]["sw_triggers_pending"] == 0


def test_legacy_config_format_imports():
    """The group's previous DAQ format ("Configuration B") must load: raw DAC
    offsets addressed by channel-in-group + group, register-convention flags,
    and GPO_BUSY mapping onto the gpo_output setting."""
    from daq import configfile
    text = """
Module 125
DRS4FREQ 0
CHNOFFSE 47000 0 0
CHNOFFSE 18536 4 0
CHNOFFSE 32768 5 0
CHNOFFSE 47000 0 1
CHNOFFSE 18536 7 1
TR0OFFSE 32768
TRG__TR0 20934
TRGPOLAR 1
POSTTRIG 0
LEMO_LEV 0
GPO_BUSY 1
"""
    cfg, notes = configfile.from_text(text)
    assert cfg.drs4_frequency == 0
    assert cfg.channels[0].dc_offset == 47000
    assert cfg.channels[4].dc_offset == 18536
    assert cfg.channels[5].dc_offset == 32768
    assert cfg.channels[8].dc_offset == 47000      # group 1 starts at ch 8
    assert cfg.channels[15].dc_offset == 18536
    assert cfg.groups[0].enabled and cfg.groups[1].enabled
    assert cfg.groups[0].fast_trigger_dc_offset == 32768
    assert cfg.groups[0].fast_trigger_threshold == 20934
    assert cfg.trigger_edge == "falling"
    assert cfg.post_trigger == 0
    assert cfg.io_level == "nim"
    assert cfg.gpo_output == "busy"
    assert any("module number 125" in n for n in notes)
    assert any("TR1" in n for n in notes)          # both banks, TR0-only file

    # A legacy file mentioning only bank 1 must turn the default bank 0 OFF -
    # the file's channel list is the whole statement of what is in use.
    only_b1, _ = configfile.from_text("CHNOFFSE 40000 0 1")
    assert not only_b1.groups[0].enabled and only_b1.groups[1].enabled


def test_runtime_url_is_always_loopback_for_a_local_window():
    """A server bound to every interface is still opened at 127.0.0.1 locally."""
    assert runtime.url_for("0.0.0.0", 8000) == "http://127.0.0.1:8000/"
    assert runtime.url_for("", 8000) == "http://127.0.0.1:8000/"
    assert runtime.url_for("127.0.0.1", 8800) == "http://127.0.0.1:8800/"
    assert runtime.url_for("10.0.0.5", 8000) == "http://10.0.0.5:8000/"


def test_runtime_record_roundtrips_and_clears():
    with tempfile.TemporaryDirectory() as d:
        os.environ["XDG_STATE_HOME"] = d
        os.environ["LOCALAPPDATA"] = d
        runtime.write("0.0.0.0", 8123)
        rec = runtime.read()
        assert rec["port"] == 8123 and rec["pid"] == os.getpid()
        assert rec["url"] == "http://127.0.0.1:8123/"
        runtime.clear()
        assert runtime.read() is None


def test_stale_and_foreign_servers_are_not_attached_to():
    """The runtime file is a hint, not an authority. A dead port, and a port held
    by some other program, must both read as 'no server' — never as one to
    attach to and drive."""
    import http.server
    import threading

    with tempfile.TemporaryDirectory() as d:
        os.environ["XDG_STATE_HOME"] = d
        os.environ["LOCALAPPDATA"] = d

        # 1. Nothing listening: the record is stale and must be cleared.
        os.makedirs(runtime.state_dir(), exist_ok=True)
        with open(runtime.runtime_path(), "w") as f:
            json.dump({"app": runtime.APP_ID, "pid": 1, "host": "127.0.0.1",
                       "port": 9, "url": "http://127.0.0.1:9/"}, f)
        assert runtime.find_server() is None
        assert runtime.read() is None

        # 2. Something answers on the port, but it is not us.
        class Impostor(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                body = json.dumps({"app": "something-else", "opened": True}).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *a):
                pass

        srv = http.server.HTTPServer(("127.0.0.1", 0), Impostor)
        port = srv.server_address[1]
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        try:
            assert runtime.probe(port, timeout=2.0) is None
            with open(runtime.runtime_path(), "w") as f:
                json.dump({"app": runtime.APP_ID, "pid": 1, "host": "127.0.0.1",
                           "port": port, "url": f"http://127.0.0.1:{port}/"}, f)
            assert runtime.find_server() is None
        finally:
            srv.shutdown()


def test_status_endpoint_identifies_the_app():
    """The launcher keys off these two fields; losing them would make every
    running server invisible to `daq`."""
    c = TestClient(create_app(_engine_without_a_unit()))
    body = c.get("/api/status").json()
    assert body["app"] == "dt5742b-daq"
    assert body["version"]


def test_bind_probe_matches_uvicorn_so_a_restart_can_reuse_its_port():
    """Closing a server leaves its connections in TIME_WAIT, and a bind without
    SO_REUSEADDR fails there — so a plain probe reports "port already in use" for
    a port uvicorn (which sets SO_REUSEADDR) would take happily. That refuses the
    server a port it could have had, for minutes after every restart."""
    import socket

    srv = socket.socket()
    srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    srv.bind(("127.0.0.1", 0))
    port = srv.getsockname()[1]
    srv.listen(1)
    client = socket.create_connection(("127.0.0.1", port))
    accepted, _ = srv.accept()
    client.close()
    accepted.close()
    srv.close()

    assert runtime.bind_probe("127.0.0.1", port) is None, \
        "the probe must mirror uvicorn's SO_REUSEADDR or restarts are refused"
    assert runtime.port_is_free("127.0.0.1", port)


def test_bind_probe_still_reports_a_port_that_is_really_taken():
    import socket

    held = socket.socket()
    held.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    held.bind(("127.0.0.1", 0))
    port = held.getsockname()[1]
    held.listen(1)
    try:
        if os.name != "nt":
            # On Windows SO_REUSEADDR permits binding over a live socket, so this
            # only holds on POSIX; there the real conflict surfaces from uvicorn.
            assert runtime.bind_probe("127.0.0.1", port) is not None
    finally:
        held.close()


def _collecting_logger(name):
    import logging
    seen = []

    class Collect(logging.Handler):
        def emit(self, record):
            seen.append(record.getMessage())

    log = logging.getLogger(name)
    log.handlers = [Collect()]
    log.setLevel(logging.DEBUG)
    log.propagate = False
    return log, seen


def test_log_steps_nest_outside_in_then_close_inside_out():
    """The ordering rule: entries appear when the work happened. A recursion
    three deep must log three opening lines outside-in, then three closing lines
    inside-out - never interleaved, never reordered."""
    from daq import logsetup

    log, seen = _collecting_logger("daq.test.steps")

    def recurse(depth):
        with logsetup.step(log, f"Level {depth}") as s:
            if depth < 3:
                recurse(depth + 1)
            s.done(f"Finished {depth}")

    recurse(1)

    opens = [m for m in seen if m.endswith("...")]
    closes = [m for m in seen if m.strip().startswith("Finished")]
    assert len(opens) == 3 and len(closes) == 3
    assert [m.strip() for m in opens] == ["Level 1...", "Level 2...", "Level 3..."]
    assert [m.strip() for m in closes] == ["Finished 3", "Finished 2", "Finished 1"]
    # The deepest open precedes the first close: starts, then ends.
    assert seen.index(opens[2]) < seen.index(closes[0])
    # Indentation reflects nesting.
    assert not opens[0].startswith(" ")
    assert opens[1].startswith("  ") and not opens[1].startswith("    ")
    assert opens[2].startswith("    ")


def test_log_conclusion_never_repeats_the_opening_line():
    """A closing line that echoes its opening reads as a new operation starting.
    The conclusion is stated in its own words."""
    from daq import logsetup

    log, seen = _collecting_logger("daq.test.wording")
    with logsetup.step(log, "Looking for a running server") as s:
        s.done("No server found")

    assert seen[0] == "Looking for a running server..."
    assert seen[1] == "No server found"
    assert "Looking for" not in seen[1]


def test_log_atomic_operations_are_one_line():
    from daq import logsetup

    log, seen = _collecting_logger("daq.test.atomic")
    logsetup.did(log, "Checking for a config file", "Ok")
    assert seen == ["Checking for a config file... Ok"]


def test_log_lines_carry_no_durations():
    """Every line is timestamped, so elapsed time is a subtraction away; printed
    durations were noise, and mostly read 0.0s."""
    import re
    from daq import logsetup

    log, seen = _collecting_logger("daq.test.timing")
    with logsetup.step(log, "Doing something") as s:
        s.done("Did it")
    logsetup.did(log, "Something atomic", "Ok")
    assert not any(re.search(r"\d+\.\d+s", m) for m in seen), seen


if __name__ == "__main__":
    for fn in [test_tiers_and_enable_is_per_group,
               test_rolling_average_matches_numpy, test_decimate,
               test_http_api, test_config_write_is_refused_with_no_unit,
               test_rate_meter_total_and_last_bucket,
               test_probe_and_reconnect_without_hardware,
               test_software_trigger_is_refused_with_no_unit,
               test_legacy_config_format_imports,
               test_runtime_url_is_always_loopback_for_a_local_window,
               test_runtime_record_roundtrips_and_clears,
               test_stale_and_foreign_servers_are_not_attached_to,
               test_status_endpoint_identifies_the_app,
               test_bind_probe_matches_uvicorn_so_a_restart_can_reuse_its_port,
               test_bind_probe_still_reports_a_port_that_is_really_taken,
               test_log_steps_nest_outside_in_then_close_inside_out,
               test_log_conclusion_never_repeats_the_opening_line,
               test_log_atomic_operations_are_one_line,
               test_log_lines_carry_no_durations]:
        fn()
        print("ok:", fn.__name__)
    print("ALL SMOKE TESTS PASSED")
