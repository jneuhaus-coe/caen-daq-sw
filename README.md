# DT5742B DAQ

Dead-simple, fast, bulletproof data acquisition for the CAEN **DT5742B** (DRS4,
16+1 ch, 12-bit, up to 5 GS/s, 1024 samples/event).

## Status

Vertical slice running end-to-end **against a simulator** — no hardware needed
to develop or demo. The real board is one swappable backend behind the same
interface; it's written but **not yet hardware-validated** (blocked on USB
passthrough into the lima guest — see *The gate* below).

Working now: config with WaveDump-seeded defaults + load/save + persist-last-used,
per-channel settings with fan-out to many/all, moving-average waveform, scrolling
trigger-rate strip, WaveDump-compatible writer, browsable command catalog, live
web UI. All smoke-tested (`server/tests`).

## Architecture

```
 browser UI ──HTTP+WebSocket──►  FastAPI server  ──►  AcquisitionEngine (own thread)
 (uPlot, static)                 (aggregates only)     │
                                                        ▼
                                              DigitizerBackend  ◄── the hardware seam
                                              ├─ SimulatorBackend   (synthetic 742 events)
                                              └─ CaenBackend        (ctypes → libCAENDigitizer)
```

The acquisition loop runs on its own thread and hands the server only small
**server-side aggregates** (averaged waveform + rate bins). The visualizer
therefore cannot throttle readout, and the wire never carries the raw event
torrent — which is why a browser client renders at native-comparable speed.
When we split client/server across a socket, the GUI moves to its own process
for free.

## Run (simulator)

```bash
cd server
pip install -e .          # or: pip install fastapi "uvicorn[standard]" numpy
python -m daq --backend sim --sim-rate 300
# open http://127.0.0.1:8000/
```

Click **Start** — you'll see live averaged waveforms and the trigger-rate strip.

## Run (real board) — after the gate passes

```bash
python -m daq --backend caen --host 0.0.0.0
```

Requires CAEN's Linux libraries in the guest (CAENComm, CAENVMELib,
CAENDigitizer; aarch64 builds exist for arm64 guests).

## The gate: USB passthrough into lima

Everything hardware-specific lives in `daq/backend/caen.py`. Before it can work,
the board must enumerate **inside the lima guest**:

```bash
lsusb | grep 21e1        # expect a CAEN device (vendor 0x21e1)
```

If nothing appears, lima's default `vz` backend isn't passing the USB device;
switch to the QEMU backend with `usb-host`, or use UTM. Until `lsusb` shows the
board, run with `--backend sim`.

## Roadmap

- [ ] Validate `CaenBackend` on hardware (enum values, per-group DC offset, decode)
- [ ] Confirm WaveDump writer byte-layout against a real dump; add ROOT/HDF5 writers
- [ ] Production React + Vite UI (this page is the vanilla proof-of-life)
- [ ] Per-channel config panel + apply-to-all in the UI
- [ ] Client/server split over the socket (colocated first)
- [ ] Packaging

## Layout

```
server/
  daq/
    constants.py     board geometry + DRS4 frequencies
    config.py        config model, defaults, load/save/persist, fan-out
    catalog.py       browsable command/setting catalog
    backend/
      base.py        DigitizerBackend ABC + Event/BoardInfo
      simulator.py   synthetic 742 backend
      caen.py        real board via ctypes (hardware-validation pending)
    stats.py         moving average + trigger-rate meter
    writer.py        Writer interface + WaveDump-compatible writer
    acquisition.py   threaded readout engine + telemetry snapshots
    server.py        FastAPI REST + WebSocket + static
    static/index.html  live uPlot UI
    __main__.py      entrypoint
```
