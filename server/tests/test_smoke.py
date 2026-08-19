"""Hardware-free smoke tests. Run: `python -m pytest` or
`python tests/test_smoke.py` from the server/ dir.

These cover config tiers/fan-out, the aggregation math, and the HTTP surface.
The acquisition loop itself needs the board and is not covered here."""
import time
import numpy as np
from fastapi.testclient import TestClient

from daq.acquisition import AcquisitionEngine
from daq.config import default_config, BoardConfig
from daq.stats import RollingAverage, TriggerRateMeter, decimate
from daq.server import create_app
from daq import constants as C


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
    # constructing the engine does not touch hardware; opening it would
    c = TestClient(create_app(AcquisitionEngine()))
    assert c.get("/api/catalog").json()["bank"]  # bank tier present
    st = c.get("/api/status").json()
    assert st["backend"] == "caen" and st["opened"] is False
    cfg = c.get("/api/config").json()
    # set ch0 offset then fan to bank
    cfg["channels"][0]["dc_offset"] = 555
    c.post("/api/config", json=cfg)
    out = c.post("/api/config/apply", json={"source": 0, "scope": "bank"}).json()
    assert out["channels"][5]["dc_offset"] == 555


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


if __name__ == "__main__":
    for fn in [test_tiers_and_enable_is_per_group,
               test_rolling_average_matches_numpy, test_decimate,
               test_http_api_and_fanout, test_probe_and_reconnect_without_hardware]:
        fn()
        print("ok:", fn.__name__)
    print("ALL SMOKE TESTS PASSED")
