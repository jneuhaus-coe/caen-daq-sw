"""Hardware-free smoke tests for the simulator path. Run: `python -m pytest`
or `python tests/test_smoke.py` from the server/ dir."""
import time
import numpy as np

from daq.acquisition import AcquisitionEngine
from daq.config import default_config, BoardConfig
from daq.stats import RollingAverage, TriggerRateMeter, decimate
from daq.server import create_app
from daq import constants as C


def test_simulator_end_to_end():
    eng = AcquisitionEngine(backend_kind="sim", sim_rate_hz=500)
    eng.open()
    eng.start()
    time.sleep(0.8)
    t = eng.telemetry()
    assert t["running"] and t["events_seen"] > 0
    ch = t["enabled_channels"][0]
    entry = t["channels"][str(ch)]
    assert len(entry["wave"]) == C.OVERVIEW_POINTS
    assert entry["count"] > 0
    # rolling rate window is fixed width regardless of how long we've run
    nbins = int(round(C.RATE_WINDOW_SECONDS / C.RATE_BIN_SECONDS))
    assert len(t["rate"]["rate"]) == nbins
    assert t["rate"]["t"][0] < 0 and t["rate"]["t"][-1] == 0.0
    eng.stop()
    assert eng.status()["running"] is False


def test_tiers_and_enable_is_per_group():
    cfg = default_config()
    assert cfg.groups[0].enabled and not cfg.groups[1].enabled
    assert cfg.enabled_channels() == list(range(0, 8))
    assert cfg.group_enable_mask == 0b01
    # per-channel DC fan-out across a bank
    cfg.channels[0].dc_offset = 1234
    cfg.apply_channel_dc_to(0, cfg.bank_channels(0))
    assert all(cfg.channels[c].dc_offset == 1234 for c in range(8))
    cfg2 = BoardConfig.from_dict(cfg.to_dict())
    assert cfg2.channels[7].dc_offset == 1234
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


def test_http_api_and_fanout():
    from fastapi.testclient import TestClient
    c = TestClient(create_app(AcquisitionEngine(backend_kind="sim", sim_rate_hz=300)))
    assert c.get("/api/catalog").json()["bank"]  # bank tier present
    assert c.post("/api/acq/start").status_code == 200
    cfg = c.get("/api/config").json()
    # set ch0 offset then fan to bank
    cfg["channels"][0]["dc_offset"] = 555
    c.post("/api/config", json=cfg)
    out = c.post("/api/config/apply", json={"source": 0, "scope": "bank"}).json()
    assert out["channels"][5]["dc_offset"] == 555
    c.post("/api/acq/stop")


if __name__ == "__main__":
    for fn in [test_simulator_end_to_end, test_tiers_and_enable_is_per_group,
               test_rolling_average_matches_numpy, test_decimate, test_http_api_and_fanout]:
        fn()
        print("ok:", fn.__name__)
    print("ALL SMOKE TESTS PASSED")
