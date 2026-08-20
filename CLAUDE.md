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
  bank at once — there is NO per-channel enable), fast-trigger (TR0/TR1)
  threshold and DC offset (`SetGroupFastTrigger*`).
- **Channel**: DC-offset trim only (`SetChannelDCOffset`, an **unsigned** uint16
  DAC word — midscale `0x8000` is no shift). The 742 has **no per-channel gain**.
  The DAC spans **±1 V — twice the 1 Vpp window** — and **increasing the DAC
  LOWERS the baseline**. Measured on serial 53364: 0.137 counts/LSB, 2.19 V
  across the full sweep (nominal 0.125 / 2.00 V). Only ~half the DAC range keeps
  the window in view at all; outside it the channel rails.
- **DC offset is the only real per-channel setting.** Probed on the board:
  `ChannelTriggerThreshold`, `ChannelSelfTrigger`, `ChannelGroupMask` and
  `ChannelPairTriggerLogic` all answer `-17`; `ChannelPulsePolarity` is a silent
  no-op. So the per-channel UI is one control, and it lives on the channel card.
- `SetChannelPulsePolarity` is a **silent no-op** on the x742: it returns
  success, and the readback stays `Positive` whatever you write. More dangerous
  than a `-17`, because it looks like it worked. Do not expose it — and note the
  DC-offset sign above is *not* polarity-dependent, verified by sweeping under
  both settings (identical slope, -0.1377).
- `SetTriggerPolarity` does take, but is **board-wide despite its per-channel
  signature**: set ch0 and ch1 differently and both read back the last value.
  Write it once, read it from channel 0.
- There is **no summable per-bank DC offset for signal channels**:
  `Set/GetGroupDCOffset` answer `-17` and libCAENDigitizer ships no
  `V1742_*GroupDCOffset`. The datasheet's "per channel or 8-channel group" is a
  family-wide statement. The only group-level offset here is TR0/TR1's.
- **`MaxNumEventsBLT` is a true event count, not a register word.** Verified
  functionally: set 1 and one `ReadData` returns exactly 1 event; set 5 and it
  returns 5. It is a *cap*, not a fixed batch - a read yields whatever is
  queued, up to the limit. Valid 1..1023: 0 fails at `MallocReadoutBuffer`
  (-2), 1024 is **silently clamped** to 1023 (set returns success), and 1025+
  give `InvalidParam` (-3). The datasheet's "1024 events/ch" is the board's
  *buffer depth*, a different quantity. Register 0x800C reads a constant 10 on
  this board, so the library enforces the BLT limit in software, not there.
- **`-1` (CommError) is a sporadic transient, not a rejection.** Roughly 1 call
  in 50 during normal use on serial 53364; an immediate retry succeeds, so
  `_get`/`_set` retry once on `-1`. Under a burst (100+ back-to-back register
  ops) the very next call fails reliably — and can keep failing while still
  taking effect, so the readback is the truth, not the return code.
  **Never conclude a feature is unsupported from a single `-1`.** Doing exactly
  that briefly convinced me 2.5 GS/s was rejected by this unit; it is not, and
  all four sampling frequencies work. `-17` is the code that means unsupported.
- **Post-trigger is quantised in time, not percent.** The register steps in
  ~8.5 ns (measured 8.45 on serial 53364). Because the API takes a whole
  percent, the *effective* increment depends on the record duration: 8.5 ns at
  5 GS/s (25 settings), then the integer percent becomes the coarser limit —
  10.24 ns at 1 GS/s and 13.65 ns at 750 MS/s, every 1%. `constants.post_trigger_steps()` derives this;
  the backend snaps before writing. Neither UM1935 nor the 742 datasheet
  mentions it — it was found by sweeping the board.
- `SetGroupTriggerThreshold` and `SetGroupSelfTrigger` return
  `CAEN_DGTZ_FunctionNotAllowed` (-17) on this board — **both set and get**.
  Verified on serial 53364. The 742 triggers on TR0/TR1 or the external input,
  not a per-group digital self-trigger, so treat those two as absent.

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
  config.py        board/bank/channel config + defaults
  catalog.py       browsable command/setting catalog (drives the UI)
  backend/
    base.py        DigitizerBackend ABC + Event/BoardInfo  <-- the hardware seam
    caen.py        real board via ctypes
  stats.py         time-windowed RollingAverage + fixed-window TriggerRateMeter + decimate
  runs.py          recorded runs on disk: create/list/zip/delete
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

## The board is the source of truth

Never let the UI show a setting the hardware did not confirm.

- **`open()` must not `Reset`.** The unit keeps its settings across our process
  restarts. Resetting on open wiped them and then read back our own defaults —
  post-trigger 0, every DC offset `0x8f00` — which looked exactly like state the
  board had chosen. `Reset` belongs only in `configure()`, where it is
  deliberate and everything is rewritten straight after.

- On open, read every setting off the board and adopt it (`read_settings`);
  the last-used file only seeds what cannot be read.
- On write, set then immediately read back (`write_settings`) and keep what the
  board reports. Mismatches and failed writes surface in `status.errors`.
- Config field types follow CAEN's API — unsigned where the API is unsigned.
- Getters that answer `-17` are recorded as write-only and left unverified;
  setters that answer `-17` are reported once, then skipped.
- **With no unit connected, a config write is refused, not stored.** It cannot
  reach the hardware and would be discarded on the next open anyway, so the
  request returns `connected: false` and the previous config. Storing it once
  produced a green "applied and read back from unit" toast with nothing
  attached. The UI also disables every hardware control while disconnected.
- Human-facing controls use human units (DC offset is volts in the UI); the DAC
  word only exists on the wire.

## Watching vs recording

They are separate actions and separate controls. **Start/Stop** acquires — live
averaged waveforms, nothing written. **Record** opens a run and begins writing;
it starts acquisition if it is not already running. Stopping a recording leaves
acquisition running, so the usual loop (watch, verify, then record) never has to
stop looking.

A run is a directory under `DAQ_DATA_DIR` (default `~/daq-runs` in the guest —
never the repo, which may be a read-only mount): one wave file per channel plus
`run_metadata.json` with the channel names and settings. One file per channel is
WaveDump's own layout (`wave_%d.txt` / `.dat`, verified against WaveDump.c).
**The directory name is the run's only name** — what the listing shows, what the
metadata records, what the downloaded zip is called. An optional ISO-ish
`-YYYY-MM-DD-HHMMSS` suffix keeps same-named runs apart; without it a clash is
an error rather than a silent rename.
Downloads are a zip of that directory. The run being recorded cannot be
downloaded or deleted.

## Conventions / scope

- Keep the **test suite minimal** — just enough smoke coverage to trust the
  hardware-free paths (rolling-average vs numpy, config tiers, HTTP API).
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
- **TR traces are never written.** WaveDump emits `TR_%d_0` / `TR_0_%d` files for
  the x742's digitized fast-trigger traces; our decoder skips channel index 8
  entirely, so enabling "Digitize TR traces" costs dead time and produces no
  file. Decode + write them before relying on TR for timing.
- The UI has not been eyeballed in a real browser yet (it was built in a headless
  cloud session). Verify layout/interactions.

## Roadmap

Exercise `CaenBackend` past open — configure/arm/read/decode against real
triggers · verify/lock the WaveDump writer against a real `.dat` · eyeball the UI
in a browser · config save/load-to-named-file in the UI · client/server over a
real socket · packaging.
