# CLAUDE.md — DT5742B DAQ

Project instructions and hard-won context for this repo. Read before working.

## Goal

Dead-simple, fast, bulletproof DAQ for the CAEN **DT5742B** digitizer (DRS4,
16+1 ch, 12-bit, ≤5 GS/s, **1024 samples/event fixed**). Windows is the eventual
primary target; today it's developed/run in a **Linux VM (lima) on macOS**.

Wanted capabilities: send commands with a browsable catalog; configure a channel
easily; apply settings to many/all; a live averaged-waveform view that never
throttles data collection; a scrolling triggers-per-bin strip; configurable
dump format. Cross-platform without a complex multi-target build (Windows main).

## Hardware & library facts (verified, external — don't re-litigate)

- **No macOS CAEN library.** CAENDigitizer/CAENComm/CAENVMELib are Windows/Linux
  only; CAENComm ships binary-only (.so + header). Native Mac is out — hence the
  Linux VM. CAEN **does** ship aarch64 Linux builds, so a native arm64 guest works.
- Board USB = plain bulk endpoints (VID `0x21e1`, OUT ep2 / IN ep6), no exotic
  chip / no kext. The wire protocol is closed, and CAEN's stack reaches the
  endpoints through its own kernel module, not libusb — see *Hardware bringup*.
- Reference for the correct 742 init/correction/decode sequence: CAEN's WaveDump
  and the x742 sample code (github.com/cjpl/caen-suite — `WaveDump.c`,
  `X742CorrectionRoutines.c`, `CAENDigitizerType.h`).
- This board: serial **53364**, ROC 04.29 build 8716, AMC 01.06 build 6530 —
  standard 742 **waveform** firmware (not DPP). Read back off the board itself.
- `BoardInfo.Channels` reads **2** on the x742 — it is the *group* count, not
  channels. Take geometry from `constants.py`, never from that field.
- **DRS4 corrections are mandatory** for trustworthy waveforms. We use the
  library's built-in path: `LoadDRS4CorrectionData` + `EnableDRS4Correction`, so
  `DecodeEvent` returns cell/time/peak-corrected floats.

### Setting tiers (verified against WaveDump's x742 branch — get these right)

- **Board**: sampling frequency, post-trigger, correction level, trigger edge,
  external/fast trigger mode, fast-trigger digitizing, max events per readout.
- **Bank (per DRS4 group of 8 channels)**: **enable** (the DRS4 digitizes a whole
  bank at once — there is NO per-channel enable), self-trigger + threshold
  (`SetGroupTriggerThreshold`), fast-trigger (TR0/TR1) threshold and DC offset
  (`SetGroupFastTrigger*`).
- **Channel**: DC-offset trim only (`SetChannelDCOffset`). The 742 has **no
  per-channel gain**.

## Board prerequisites

The app needs only that `libCAENDigitizer` can open the unit. Prerequisites:

- CAENDigitizer, CAENComm, CAENVMELib
- CAEN USB kernel driver (`CAENUSBdrvB` on Linux)
- udev rule for non-root access (Linux)
- Python 3.10+

Verified open on the real unit: DT5742B, serial 53364, ROC 04.29 / AMC 01.06.
`OpenDigitizer` returning `-1` while `lsusb` shows the board means the USB
driver is missing.

**Windows is the deployment target.** The Mac + lima guest is a dev convenience
for fast iteration; keep host-specific setup out of this repo.

## Architecture

Server owns the hardware; browser renders; they talk over HTTP + WebSocket.
The server sends only **aggregates** (decimated averaged waveforms + a rolling
rate window), so the UI can never throttle readout and a browser renders as fast
as native. Colocated for v1; the socket boundary makes a remote/Mac GUI free later.

```
server/daq/
  constants.py     geometry, DRS4 freqs, display/aggregation constants
  config.py        board/bank/channel config; defaults, load/save, persist-last-used, fan-out
  catalog.py       browsable command/setting catalog (drives the UI)
  backend/
    base.py        DigitizerBackend ABC + Event/BoardInfo  <-- the hardware seam
    caen.py        real board via ctypes
  stats.py         time-windowed RollingAverage + fixed-window TriggerRateMeter + decimate
  writer.py        Writer interface + WaveDump-compatible writer
  acquisition.py   threaded readout engine + telemetry snapshots
  server.py        FastAPI REST + WS + static
  __main__.py      entrypoint
web/               React + Vite + TypeScript + uPlot; builds into server/daq/static
```

The hardware is isolated behind `DigitizerBackend`; `CaenBackend` is the only
implementation, so hardware work touches only `caen.py`.

## Run / dev

```bash
cd server && pip install -e .            # one-time, editable
python -m daq                            # http://127.0.0.1:8000/
cd server && python tests/test_smoke.py  # hardware-free smoke tests
cd web && npm install && npm run build   # rebuild UI into server/daq/static
cd web && npm run dev                     # UI hot-reload, proxies API/WS to :8000
```

Run the server on the machine physically attached to the board.

The macOS host has no node, so the UI cannot be rebuilt there; the committed
`server/daq/static/` bundle is what gets served.

## Conventions / scope

- Keep the **test suite minimal** — just enough smoke coverage to trust the
  hardware-free paths (rolling-average vs numpy, config tiers/fan-out, HTTP API).
  Don't grow coverage for its own sake. The acquisition loop needs the board.
- Config changes autosave + persist as last-used. Per-channel DC-offset fans out
  to bank/all; board/bank settings are edited directly (not fanned out).
- The `Writer` interface is byte-compatible-WaveDump for v1; ROOT/HDF5 are meant
  to slot in behind it.

## Known-pending / gotchas

- `caen.py` is structurally faithful (call order + structs from CAEN's headers).
  `OpenDigitizer`/`GetInfo`/`CloseDigitizer` are now **verified on the board**;
  everything past that — configure, arm, read, decode — is still **unexercised**.
  Most likely to need tweaks: enum values, per-group vs per-channel offset math,
  the decode/correction path.
- WaveDump writer layout follows the docs but is **not byte-verified** against a
  real dump — check against one sample `.dat` before trusting downstream.
- The UI has not been eyeballed in a real browser yet (it was built in a headless
  cloud session). Verify layout/interactions.

## Roadmap

Exercise `CaenBackend` past open — configure/arm/read/decode against real
triggers · verify/lock the WaveDump writer against a real `.dat` · eyeball the UI
in a browser · config save/load-to-named-file in the UI · client/server over a
real socket · packaging.
