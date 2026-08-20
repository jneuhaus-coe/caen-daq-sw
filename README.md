# DT5742B DAQ

Dead-simple, fast, bulletproof data acquisition for the CAEN **DT5742B** (DRS4,
16+1 ch, 12-bit, up to 5 GS/s, 1024 samples/event).

## Status

Vertical slice wired end to end against the real board. The DT5742B opens and
identifies (serial 53364, ROC 04.29 / AMC 01.06); `CaenBackend` is verified that
far, while configure, arm, read and decode are **not yet exercised** against real
triggers. Windows is the deployment target.

Working now: config with WaveDump-seeded defaults + load/save + persist-last-used,
per-channel DC offset in volts, moving-average waveform, scrolling
trigger-rate strip, WaveDump-compatible writer, named runs with download/delete,
browsable command catalog, live React web UI. All smoke-tested (`server/tests`).

## Architecture

```
 browser UI ──HTTP+WebSocket──►  FastAPI server  ──►  AcquisitionEngine (own thread)
 (uPlot, static)                 (aggregates only)     │
                                                        ▼
                                              DigitizerBackend  ◄── the hardware seam
                                              └─ CaenBackend        (ctypes → libCAENDigitizer)
```

The acquisition loop runs on its own thread and hands the server only small
**server-side aggregates** (averaged waveform + rate bins). The visualizer
therefore cannot throttle readout, and the wire never carries the raw event
torrent — which is why a browser client renders at native-comparable speed.
When we split client/server across a socket, the GUI moves to its own process
for free.

## Run

On the machine physically attached to the digitizer:

```bash
cd server
pip install -e .          # or: pip install fastapi "uvicorn[standard]" numpy
python -m daq --host 0.0.0.0
# open http://<host>:8000/ and click Start
```

Prerequisites:

- CAENDigitizer, CAENComm, CAENVMELib
- CAEN USB kernel driver (`CAENUSBdrvB` on Linux)
- udev rule for non-root access (Linux)
- Python 3.10+

Everything hardware-specific lives in `daq/backend/caen.py`. If `OpenDigitizer`
fails with `-1` while the board is visible on USB, the driver is missing.

## Roadmap

- [x] Open and identify the board over USB (CAEN driver + libs)
- [x] Production React + Vite + TypeScript UI (uPlot)
- [x] Per-channel config panel + apply-to-all in the UI
- [ ] Exercise `CaenBackend` past open: configure, arm, read, decode real triggers
      (enum values, per-group DC offset, DRS4 correction path)
- [ ] Confirm WaveDump writer byte-layout against a real dump; add ROOT/HDF5 writers
- [ ] Eyeball the UI in a browser against live data
- [ ] Client/server split over the socket (colocated first)
- [ ] Packaging

## Layout

```
server/
  daq/
    constants.py     board geometry + DRS4 frequencies
    config.py        config model + defaults
    catalog.py       browsable command/setting catalog
    backend/
      base.py        DigitizerBackend ABC + Event/BoardInfo
      caen.py        real board via ctypes
    stats.py         moving average + trigger-rate meter
    writer.py        Writer interface + WaveDump-compatible writer
    acquisition.py   threaded readout engine + telemetry snapshots
    server.py        FastAPI REST + WebSocket + static
    static/          built web UI (generated — build from web/, don't edit)
    __main__.py      entrypoint
  tests/             hardware-free smoke tests
web/                 React + Vite + TypeScript UI source (uPlot)
```
