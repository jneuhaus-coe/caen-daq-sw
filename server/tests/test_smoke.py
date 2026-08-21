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
    c = TestClient(create_app(AcquisitionEngine()))
    assert c.get("/api/catalog").json()["bank"]  # bank tier present
    st = c.get("/api/status").json()
    assert st["backend"] == "caen" and st["opened"] is False


def test_config_write_is_refused_with_no_unit():
    """With nothing attached the write goes nowhere, so it must be reported as
    a failure and must not change the stored config. Claiming success here once
    produced a green 'applied and read back from unit' toast with no unit."""
    from fastapi.testclient import TestClient
    c = TestClient(create_app(AcquisitionEngine()))
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
    eng = AcquisitionEngine()
    assert eng.probe() is False
    assert eng.status()["opened"] is False
    assert eng.reconnect()["opened"] is False
    c = TestClient(create_app(eng))
    assert c.get("/api/status").json()["opened"] is False
    assert c.post("/api/board/reconnect").json()["opened"] is False


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
    c = TestClient(create_app(AcquisitionEngine()))
    body = c.get("/api/status").json()
    assert body["app"] == "dt5742b-daq"
    assert body["version"]


if __name__ == "__main__":
    for fn in [test_tiers_and_enable_is_per_group,
               test_rolling_average_matches_numpy, test_decimate,
               test_http_api, test_config_write_is_refused_with_no_unit,
               test_rate_meter_total_and_last_bucket,
               test_probe_and_reconnect_without_hardware,
               test_runtime_url_is_always_loopback_for_a_local_window,
               test_runtime_record_roundtrips_and_clears,
               test_stale_and_foreign_servers_are_not_attached_to,
               test_status_endpoint_identifies_the_app]:
        fn()
        print("ok:", fn.__name__)
    print("ALL SMOKE TESTS PASSED")
