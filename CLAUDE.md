# CLAUDE.md — DT5742B DAQ

Project instructions and hard-won context for this repo. Read before working.

## Goal

Dead-simple, fast, bulletproof DAQ for the CAEN **DT5742B** digitizer (DRS4,
16+1 ch, 12-bit, ≤5 GS/s, **1024 samples/event fixed**). **Live runs happen on
Windows**; the Linux VM on macOS is only where it gets developed. Keep the
Windows path working — it is the one that matters at the beamline.

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
  `X742CorrectionRoutines.c`, `CAENDigitizerType.h`). The 742 register map is
  UM5698, committed under `docs/`.
- The group's original DAQ (github.com/carlosperezlara/Dec21_RADiCAL,
  `x742/acquire/source/daq.cc`) is hard-coded, not config-driven — the
  "Configuration B" spreadsheet was values transcribed into the source by
  hand, and our legacy importer reads that sheet's key format. Facts mined
  from it: TR0 fits for that setup (threshold mV ~ (DAC - 25448) * 0.0329
  - WRONG, see TR0 below; TR DC offset mV ~ -(DAC - 33540) * 0.0466 - the
  slope is right, 0.19 window counts/LSB as UM4270 Tab. 9.1 implies, but
  the intercept is whatever their TR0 had plugged in, not a calibration),
  and its GPO-busy write `(3<<18)|(1<<16)` to 0x811C — the same field value
  `gpo_output = "busy"` writes, an independent confirmation. Do NOT copy its
  channel DC-offset block: it is commented out and shifts the channel-select
  field by 17 where 0x1n98 wants bits[19:16] (UM5698 sec 1.9) —
  `SetChannelDCOffset` does this correctly.
- **Per-board 0 V calibration (`zerocal.py`, calibrator mode "zero").**
  UM4270 only says DC offset 0x8000 lands "ideally around" code 2048.
  Measured on serial 53364 with EVERY input unplugged/terminated
  (2026-10-07): TR0 copies at ~2200/2190, signal channels ~2584-2631 -
  74 and ~140 mV of display error; the DRS4 corrections move this <10
  codes, so it is the board, not our decode. The TR0 comparator, swept
  on the same terminated input, matched CAEN's 0x6666 = 0 V to within
  2 mV - so without the zero file the trace and its trigger line
  disagree. The file stores ONE point per input: the code a 0 V input
  reads at its 0 V of offset (0x8F00 channels, 0x8000 TR0); the display
  moves it with the NOMINAL slope - by decision, no fitted slope (the
  board is ~10% steeper, so far from 0x8F00 that error grows). The UI's zero line
  (`volts.zeroLine`) uses it for the PLOTS only - offset fields, sliders
  and toasts stay nominal (0 V of offset = 0x8F00 channels, 0x8000 TR0),
  or a fresh board's 0x8F00 reads as a few mV -
  DISPLAY ONLY, recorded data untouched. It is measured ONLY with known
  0 V inputs; an input that is not quiet blocks the save. Never derive
  a zero from a connected signal (an earlier "+145 mV" figure was taken
  that way and was right only by luck).
- This board: serial **53364**, ROC 04.29 build 8716, AMC 01.06 build 6530 —
  standard 742 **waveform** firmware (not DPP). Read back off the board itself.
- `BoardInfo.Channels` reads **2** on the x742 — it is the *group* count, not
  channels. Take geometry from `constants.py`, never from that field.
- **DRS4 corrections are mandatory** for trustworthy waveforms. We use the
  library's built-in path: `LoadDRS4CorrectionData` + `EnableDRS4Correction`, so
  `DecodeEvent` returns cell/time/peak-corrected floats.
- **The library's time correction RESAMPLES onto a uniform grid** (linear
  interpolation, see `X742CorrectionRoutines.c` shipped with WaveDump) - a
  small low-pass on every pulse edge, which matters at ps-level timing. The
  "timing" correction mode (`backend/corrections.py`) applies only the
  amplitude corrections (cell, nsample, peak - a numpy port of the same
  routine, same tables via `GetCorrectionTables`) and records each event's
  TRUE non-uniform time axis plus the trigger cell instead. Verified on
  serial 53364: cell widths spread 196.6-202.0 ps around the nominal 200
  (sigma ~1 ps/cell - the aperture non-uniformity itself), the axis closes
  to exactly 204.6 ns, and baselines agree with the library path to the
  count. **"timing" is the default** - this is a timing program - with
  "auto" kept for anything downstream that assumes uniform sampling.

### Setting tiers (verified against WaveDump's x742 branch — get these right)

- **Board**: sampling frequency, post-trigger, correction level, trigger edge,
  external/fast trigger mode, fast-trigger digitizing, max events per readout.
- **Bank (per DRS4 group of 8 channels)**: **enable** (the DRS4 digitizes a whole
  bank at once — there is NO per-channel enable), fast-trigger (TR0/TR1)
  threshold and DC offset (`SetGroupFastTrigger*`).
- **Channel**: DC-offset trim only (`SetChannelDCOffset`, an **unsigned** uint16
  DAC word — midscale `0x8000` is no shift). The 742 has **no per-channel gain**.
  UM4270 rev 13 sec 9.1 / Fig. 9.1: the DAC shifts the 1 Vpp window **±1 V**
  (FSR/2 = bipolar -0.5..+0.5 V); raising the DAC raises the window, so a
  fixed input lands on a LOWER code. Measured slope on serial 53364: 0.137
  counts/LSB, 2.19 V across the sweep (nominal 0.125 / 2.00 V); re-measured
  2026-10-07 at 0x7F00/0x8F00/0x9F00, inputs open: -0.0335 mV/count average
  (-0.03325..-0.03379), ~10% steeper than nominal -0.0305. The UI shows the
  offset as the **input voltage at the window centre**, with **0 V of
  offset = 0x8F00** (`C.DC_OFFSET_ZERO`): the power-on default, "about 0mV"
  per the V1742 manual sec 5.7. The nominal model puts a 0 V input at code
  2048 there; measured, inputs open, channels read 2046-2138 (95% range for
  a channel 2033-2143, mean ~2088). TR0 keeps 0x8000 as its zero.
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

- **TR0 (UM4270 rev 13, `docs/UM4270_DT5742_UserManual_rev13.pdf`, sec
  9.1.2 and 9.8.3 / Tab. 9.1; same examples in the V1742 manual sec 5.15).**
  - Input: 2 Vpp, attenuated **x2** into the 1 Vpp DRS4 on mezzanine PCB
    rev >= 1. bit[9] of 0x1088/0x1188 reads 1 on serial 53364 (2026-10-06).
  - Threshold at offset 0x8000: 0x6666 = 0 V at the input, 13.2 steps per
    mV AT THE INPUT (NIM 0..-800 mV -> 0x51C6 = -400 mV). The threshold
    field is input volts; the x2 only scales the digitized trace.
  - TR DC offset: raising it LOWERS the code a fixed input lands on (as for
    the channels), **1 V at the input per 10240 steps** - Tab. 9.1's TTL
    row (0xA800 centres a 0..2 V signal). A delta sweep on serial 53364
    (2026-10-06, +/-4096 steps) measured -0.198 window counts/step, both
    groups, agreeing to 1%. The manual's "factor of 16" sentence only says
    32768 lands near code 2048; read as a slope it is 3.2x wrong. The UI
    shows the TR offset as the volts the DAC shifts TR0, **0 = midscale
    0x8000** - deliberately NOT through the 0 V calibration, which would put
    "0" at ~33576 and strip the threshold of its reference.
  - TR0's trace uses its own zero: a 0 V input reads **code 2200** at
    0x8000 (`volts.TR_ZERO_CODE`; terminated, the copies read 2204/2194),
    not the 2048 the channels assume - 150 codes is ~75 mV at the input.
  - The off-midscale rows (ECL 0x55A0, TTL 0xA800 vs "positive 0-2 V"
    0x91A7) do not fit one threshold line - the manual's "no simple
    formula". The TR0 trigger line is drawn ONLY at offset 0x8000.
  - The family datasheet (`docs/DS3159_742_Digitizer_Family_r2.pdf`) agrees
    on the channel offset range (+/-1 V); UM5698's "DAC range ~5% larger
    than ADC range" is family-generic text.
  - Beam history, 2026-08-28: the TR0 input is attenuated x2 into a fast
  comparator (0-2.5 V dynamic). CAEN's arithmetic - threshold DAC moves
  13.2 counts per connector-mV, signal 0-Volt at DAC 0x6666 = 26214 - is
  valid ONLY with the TR DC offset at midscale 0x8000; the manual states
  outright that no formula exists at other offsets, and it means it: with
  the offset at DAC 25815 (+0.36 V readout baseline, needed so the full
  MCP pulse digitizes unclipped), measured trigger turn-ons vs threshold
  DAC came out NON-MONOTONIC (33731 -> ~250 mV, 34567 -> 164 mV, 37983 ->
  ~220 mV, 46054+ -> no triggers at all). Off-midscale the threshold is
  tuned EMPIRICALLY: adjust until counts, then measure the actual cut as
  the turn-on edge of the recorded MCP pulse-depth spectrum (each run's
  metadata carries the trigger settings for exactly this). Known-good
  anchors: canonical NIM row (offset 32768 / threshold 20934 / falling) =
  CAEN's own -400 mV example, triggers reliably; and the beam-tuned point
  offset 25815 / threshold 34567 / falling = measured 164 mV cut with the
  spectrum bulk retained. The RADiCAL bench constant (0.0329 mV/LSB, zero
  25448) and every extrapolated "measured slope" from sparse edges FAILED
  on this unit - do not resurrect them. The permanent fix for the
  offset-vs-threshold tension is a passive splitter: MCP -> TR0 (trigger
  only, midscale offset, manual arithmetic) + a spare signal channel
  (3, 8-11 are empty) for full-fidelity pulse digitization.

- **Never derive a reference level from the signal being measured.** The
  TR0 trigger line once rode the live median of the trace (jittering with
  the input), and a later attempt baked a median of whatever was plugged in
  into a constant as "0 V". Both are wrong: volts come from the ADC code
  and the registers through CAEN's documented relationship, corrected only
  by the per-board 0 V calibration measured on known 0 V inputs.
  Plots are in **input volts** (`MiniWave` vScale/vOffset): full scale is
  exactly ADC codes 0..4095 at the current offset, so the axis moves with
  the offset register and a trace holds still. The ROOT writer is still
  window-referenced (`1000*(code/4095 - 0.5)` mV) - left as is on purpose.
  Volts fields print the shortest text that maps back to the exact DAC
  word (`fmtDacVolts`), never a fixed `toFixed(3)`.

- **Link selection is DAQ_LINK** (environment, read at every open): a comma
  list tried in order - `usb` (default when unset), `a4818:<pid>` (the A4818
  USB 3.0 -> CONET optical adapter; the PID is the number printed on its
  label, also its USB serial), `optical[:num]` (A2818/A3818 PCIe). Set it
  persistently with `setx DAQ_LINK "a4818:<pid>,usb"` and restart daq - the
  optical link (~80 MB/s) is the only path past USB 2.0's ~1 kHz event
  ceiling toward the board's ~3 kHz. Needs CAENDigitizer >= 2.17 (this box:
  2.18.0) and the A4818 driver. An entry that cannot work (a4818 without a
  PID, junk) is skipped with a log line, never fatal.

## Board prerequisites

The app needs only that `libCAENDigitizer` can open the unit. Prerequisites:

- CAENDigitizer, CAENComm, CAENVMELib
- CAEN USB kernel driver (`CAENUSBdrvB` on Linux)
- udev rule for non-root access (Linux)
- Python 3.10+

Verified open on the real unit: DT5742B, serial 53364, ROC 04.29 / AMC 01.06.
`OpenDigitizer` returning `-1` while `lsusb` shows the board means the USB
driver is missing.

- **Board-config bit[8] ("Individual trigger") MUST be 1, and a power cycle
  clears it.** UM5698 sec 1.15 says so outright; with it 0 the board counts
  triggers normally and delivers HEADER-ONLY events - hundreds seen, all
  empty, no error anywhere. Soft resets preserve a previously-set 1, so
  leftover state from other software (WaveDump/CAENScope) masked this for
  two days until a power cycle produced 928 perfectly counted, perfectly
  empty events. configure() sets it at every arm via the 0x8004 bit-set
  register. Symptom to remember: "triggers but no waveforms" = check bit[8].
- **DC-offset DAC writes during acquisition never reach the analog output.**
  Measured on serial 53364: write a channel DC offset while acquiring and the
  register updates - readback agrees, no error anywhere - but the baseline
  does not move until the next arm (SWStartAcquisition after a stop, when
  configure() rewrites settings with the board stopped). Distinct from the
  SPI-busy silent drop below, which corrupts the REGISTER too. Consequence:
  anything that must see an offset take effect (the calibrator) stops,
  writes, re-arms, then measures; a slider tweak mid-acquisition looks
  applied but is not, until the next re-arm.
- **A power cycle under a running acquisition must end "acquiring".** It
  used not to: the unit came back disarmed, reads failed too slowly or not
  at all, and the UI said acquiring indefinitely. Now the readout thread,
  after `QUIET_CHECK_S` with no events, reads 0x8104 bit 2 (RUN, UM5698 sec
  1.20) via `backend.armed()` - on its own thread, so it never races
  ReadData - and a disarmed board is treated as lost (reopen re-reads its
  settings). A read stuck in the driver past `READ_STALL_S` is abandoned
  by status(); the loop's generation counter keeps that thread from acting
  if its call ever returns. Verified on serial 53364 that a quiet, armed
  board reads RUN=1 (no false loss); the power-cycle path itself is covered
  only by the fake-backend smoke test.
- **The Windows CAEN USB driver can wedge, and the signature is distinctive:**
  `OpenDigitizer` returns `-1` on a board Device Manager shows healthy, an
  occasional open *hangs* inside the driver instead of returning (one took 66 s
  to fail, another never came back), and the hung process **survives
  TerminateProcess** — a thread blocked in an uninterruptible kernel call
  cannot die, which is why `daq stop` reports a process still running after a
  kill that "succeeded". Seen live on serial 53364 under CAENUSBdrv.sys 3.4.9
  (2014 — the newest CAEN ships for the DT57xx) on Windows 11 with the unit on
  a USB 3 root hub. The remedy is physical: power-cycle or replug the unit to
  cancel the stuck I/O (reboot if that fails), and keep USB selective suspend
  off for the port. Do not diagnose software from anything a wedged driver
  says.
- **So the driver is never called at the wrong moment (`usbwatch.py`).**
  After a power cycle, OpenDigitizer blocked 24-58 s per attempt and then
  failed (2026-10-07). A raw open on a booted unit takes ~10 ms. The trigger
  was our 5 s auto-retry calling the driver while the unit was off or still
  booting. Every USB open is now gated on Windows' device list (cfgmgr32,
  VID 0x21E1 PID 0). Nothing is sent while the unit is absent, or for
  `USB_SETTLE_S` after it appears. Losing an open unit restarts that clock,
  so a quick off/on still gets its boot time. **The scan is on demand, not a
  polling thread:** it runs only while the unit is NOT open, at most once
  per `USB_POLL_S` (1 s), and only when a status poll asks. While connected
  there are no scans at all - this is a shared beamline PC, not ours to
  spin on. Verified 2026-10-08: a stuck open was released only by a power-off
  (after 3m20s). The board then reappeared, was left 5 s, and reconnected
  first try. **The 5 s settle is measured, do not shorten it.** Opens 2.3 s
  after the unit appeared on USB following a POWER-ON hung 3 of 3 times
  (17 s, 45 s, 65+ s). Opens at 6.0/6.0/7.2 s were fine (2026-10-08). A
  cable replug (board never lost power) opened fine at 1.5 s, but from the
  host a replug and a power cycle look identical, so both pay the 5 s. An
  `a4818:` entry is skipped while no other CAEN USB device (the adapter) is
  present. Before that, an absent A4818 in DAQ_LINK put the whole open
  back on the 5 s retry timer, and a cable replug took ~12 s. Reconnect pressed during an in-flight open
  reports "still connecting" - it used to say "No unit found", which sent
  the operator off to power-cycle the unit mid-connect.

**Windows is the deployment target.** The Mac + lima guest is a dev convenience
for fast iteration; keep host-specific setup out of this repo.

- On Windows the CAEN API is **`__stdcall`** (`#define CAENDGTZ_API __stdcall`
  under `_WIN32`), so `_load_lib` uses `WinDLL` there and `CDLL` elsewhere. The
  two coincide on x64, so a cdecl mistake hides until someone runs 32-bit
  Python — do not "simplify" it back to one loader.
- Python and the CAEN DLLs must have the same bitness, and the failure when they
  do not is unhelpful. 64-bit both.
- Nothing else in `server/daq` assumes a platform: paths go through
  `os.path`/`expanduser`, so runs land in `~/daq-runs` or
  `%USERPROFILE%\daq-runs` without special casing.

## Architecture

Server owns the hardware; browser renders; they talk over HTTP + WebSocket.
The server sends only **aggregates** (decimated averaged waveforms + a rolling
rate window), so the UI can never throttle readout and a browser renders as fast
as native. Colocated for v1; the socket boundary makes a remote/Mac GUI free later.

```
server/daq/
  constants.py     geometry, DRS4 freqs, display/aggregation constants
  config.py        board/bank/channel config + defaults
  configfile.py    save/load; our JSON and CAEN WaveDumpConfig.txt
  catalog.py       setting catalog incl. operator-facing help (drives the UI)
  backend/
    base.py        DigitizerBackend ABC + Event/BoardInfo  <-- the hardware seam
    caen.py        real board via ctypes
  stats.py         RollingAverage (time or event window) + TriggerRateMeter + decimate
  runs.py          recorded runs on disk: create/list/zip/delete
  writer.py        Writer interface + WaveDump-compatible writer
  acquisition.py   threaded readout engine + telemetry snapshots
  server.py        FastAPI REST + WS + static
  update.py        `daq update`: release check, then hand-over to the installer
  __main__.py      entrypoint
web/               React + Vite + TypeScript; builds into server/daq/static
```

The hardware is isolated behind `DigitizerBackend`; `CaenBackend` is the only
implementation, so hardware work touches only `caen.py`.

## Run / dev

```bash
cd server && pip install -e .            # one-time, editable
python -m daq                            # http://127.0.0.1:8800/
cd server && python tests/test_smoke.py  # hardware-free smoke tests
cd web && npm install && npm run build   # rebuild UI into server/daq/static
cd web && npm run dev                     # UI hot-reload, proxies API/WS to :8800
cd web && npm run test:ui                 # Playwright UI suite (DAQ_BACKEND=fake)
```

## Logging and startup

- **`logsetup.configure()` owns logging.** Console at the chosen level, plus a
  rotating file at DEBUG always (`<state dir>/logs/daq.log`, 2 MB x 5) so a
  problem reported from a distance can be answered from a file. uvicorn's
  loggers are re-parented onto ours (`log_config=None` in `uvicorn.Config`), so
  HTTP and hardware appear in one chronological account instead of two streams.
  Access logging is on only at `--log-level debug`; the UI polls status every
  second and would otherwise bury everything.
- **Log along transactional boundaries, and in exactly two shapes.**
  - Atomic work is one line: `logsetup.did(log, "Checking for a config file",
    "Ok")` -> `Checking for a config file... Ok`. Use it whenever nothing can be
    logged between starting and finishing.
  - Work that logs while it runs is two lines: `with step(log, "Looking for a
    running server") as s: s.done("No server found")`. **The conclusion is
    stated in its own words and must never echo the opening** - a closing line
    that repeats its opening reads as a new operation starting, which is what
    made an earlier version unusable. A test enforces it.
  - **Nothing is timed.** Every line is timestamped, so elapsed time is a
    subtraction away; printed durations were noise and mostly read `0.0s`.
  - Entries appear in the order the work happened - a recursion three deep
    writes three opens outside-in, then three closes inside-out - and nesting
    shows as indentation, kept per-thread so the readout thread and a request
    handler do not corrupt each other. Tests assert that ordering.
  - `s.failing("...")` supplies failure wording *for a raise*; an early
    `return` is not a raise, so use `s.done("Not started: ...")` there or the
    step cheerfully concludes "Done" about work that did not happen.
  - Do not override the failure wording where the exception carries the cause:
    "No digitizer found" hid "libCAENDigitizer not found. Install ...".
  - Pass `level=logging.DEBUG` for expected failures (the automatic reconnect
    retries); the closing line drops to DEBUG with it, instead of shouting ERROR
    every few seconds while no unit is plugged in.
- **HTTP is not a transaction.** Access logging is off unconditionally, and
  `uvicorn.error`, `uvicorn`, `websockets*` and `asyncio` are pinned to WARNING
  in `_NOISY`. The websockets library logs every frame at DEBUG, which buried
  the log under `> TEXT '{...}'` on every telemetry push, and uvicorn lends its
  own logger to websockets so silencing one without the other does nothing. Our
  own lines already cover startup and shutdown.
- **Starting acquisition with no unit refuses**, it does not raise: an exception
  through the API produced a full ASGI traceback in the log and a 500 in the UI,
  saying nothing the badge did not.
- Keep log message text ASCII - a Windows console in cp1252 cannot encode an em
  dash, and the handler raises when it tries.
- Prefer `log.info(...)` over `print`. `print` block-buffers when stdout is not
  a terminal, so a service log stays empty until the buffer fills — which reads
  as a hang. Handlers flush on every record.
- **The digitizer opens on a worker thread**, and startup waits only
  `BOARD_OPEN_WAIT_S` (5 s) before serving the UI anyway. The badge renders
  disconnected and turns green by itself. Announce before slow work: with no
  output until the open finished, a normal startup was indistinguishable from a
  hang, which is exactly how it was reported.
- That made `AcquisitionEngine._open_lock` necessary. `probe()` runs on every
  status poll and calls `_try_open()`, so a poll arriving mid-open would have
  started a **second** open on the same handle. `_try_open` now takes the lock
  non-blockingly and gives up if an open is already running, and `open()` sets
  `_opened` **last** so every other path keeps off the wire until the unit is
  fully set up.

## Packaging and install

Operators install with a one-liner (`install.sh` / `install.ps1` at the repo
root) that installs **uv**, which brings its own pinned 64-bit CPython and then
installs the release wheel as a uv tool. Bringing the interpreter along is the
point: it makes the Python/CAEN-DLL bitness mismatch impossible. Updating is
`daq update`, which runs that same installer (see *Updating in place*).

- **`uv tool install` must pass `--managed-python`.** Without it uv builds the
  tool on any Python 3.11 it discovers — on one beamline machine that was the
  **Microsoft Store Python**, whose MSIX filesystem virtualization silently
  redirects `%LOCALAPPDATA%\dt5742b-daq` (runtime.json, logs) into the
  package's `LocalCache`. Everything *inside* that sandbox stays consistent, so
  it mostly works — until `daq status` names a log file that does not exist at
  the printed path, and no process outside the sandbox can see the runtime
  record. The venv's `pyvenv.cfg` `home` pointing under `WindowsApps` is the
  tell.

- **`daq/static/` is not an importable package**, so `packages.find` cannot see
  it and setuptools silently drops the UI from the wheel unless
  `[tool.setuptools.package-data]` names it. The symptom is a blank page, not a
  build error. Both workflows assert `daq/static/index.html` is inside the built
  wheel — leave those assertions alone.
- **`__version__` in `daq/__init__.py` is the single source of truth.**
  `pyproject.toml` reads it via `[tool.setuptools.dynamic]`, and the release
  workflow refuses to publish if the git tag is not `v$__version__`.
- **The release waits for CI on its own commit.** Every push to `main` runs CI —
  a push can carry commits CI has never seen, so it must. `release.sh` pushes
  the branch first and then the tag; the tag build's `wait-for-ci` job polls the
  Actions API for CI runs on that exact SHA and refuses to publish unless they
  are green. If no CI run exists for the SHA it proceeds rather than hanging,
  which is what makes tagging an older commit work. An earlier attempt made CI
  *skip* release commits instead — that was wrong: the skip keyed off the head
  commit, so a push carrying real work plus a bump went untested entirely.
- Releases are tag-driven: push `vX.Y.Z`, the workflow builds the UI from
  `web/src`, builds wheel + sdist, smoke-tests the wheel, and attaches the
  artifacts plus both install scripts. The one-liners download from there.
- The installers resolve the installed binary with `uv tool dir --bin` rather
  than `command -v daq`, and warn when a different `daq` shadows it on PATH — a
  stale copy makes an update look like a no-op, which is horrible to debug
  remotely.
- **Updating stops the server first — that is a requirement, not a side effect.**
  Both installers find the running `daq`, refuse (naming the run) if one is
  recording or if the process cannot be reached at the port it recorded, and
  otherwise stop it and tell the operator to start it again. On Windows this is
  also forced: a running `daq.exe` cannot be replaced at all.
- The recommended systemd unit is **`Restart=on-failure`, never `always`**.
  systemd counts SIGTERM as a clean exit, so `on-failure` still recovers from a
  crash while letting a deliberate shutdown stay down. With `always` systemd
  restarts the server mid-update, and because Linux replaces a running binary
  happily, the update finishes with the OLD code serving and nothing to show it.
  Both installers wait past a typical `RestartSec` and refuse loudly if the
  server reappears. Auto-restart cannot rescue a recording anyway — the run is
  already truncated and does not resume.
- On Linux, `pgrep` matches **zombies**, so a correctly-killed server looks like
  one that refused to die. `daq_pids()` filters on process state; do not
  simplify it back to a bare `pgrep`.
- **On Windows the server is `pythonw.exe`, not `daq.exe`.** The launcher starts
  it windowless from inside the uv tool environment, so `Get-Process -Name daq`
  never sees it. When the installer missed it, uv failed to replace that
  environment with *"failed to remove directory (the uv scripts directory):
  Access is denied"* — the running interpreter lives in the directory being
  deleted. `Get-DaqProcesses` matches on executable **path** under `uv tool dir`
  instead; do not put the name check back. The install also retries three times,
  because Windows can hold a handle for a moment after the process exits.
- **`Die` must `throw`, never `exit`.** The documented invocation is
  `irm ... | iex`, and `exit` inside `Invoke-Expression` terminates the caller's
  PowerShell session - closing the window on the very message the user needs.
  Verified both ways under pwsh.
- **Never redirect a native command's stderr** (`2>$null`, `2>&1`) in this
  script. Under `ErrorActionPreference = 'Stop'`, Windows PowerShell 5.1 turns
  those records into a terminating error; that is what killed the script at
  `uv tool update-shell`. Use try/catch. Note pwsh 7 does *not* reproduce it, so
  local testing on 7.x will not show the bug.
- **Keep `install.ps1` pure ASCII.** Without a BOM, PowerShell 5.1 decodes the
  file as ANSI, so an em dash arrives as mojibake. CI lints for this.
- CI parses and lints `install.ps1` with PSScriptAnalyzer, the counterpart to
  shellcheck on `install.sh`. PowerShell can be run locally for the same checks:
  download a self-contained pwsh and `Save-Module PSScriptAnalyzer`.
- **Call uv directly in `install.ps1`; never through `Start-Process`.** A
  `Start-Process -PassThru` wrapper was added to impose a timeout and broke the
  installer two ways: the returned object's `ExitCode` is frequently `$null`, so
  `$null -eq 0` judged a *successful* install a failure and the retry then
  uninstalled it; and `Start-Process` does not quote its arguments, which splits
  the PEP 508 spec (`dt5742b-daq @ https://...`) into three. Native invocation
  quotes correctly and sets `$LASTEXITCODE` reliably.
- **Judge the install by what is on disk**, not by uv's exit code: `daq.exe`
  exists and `daq --version` runs. The retry deletes the tool environment, so
  believing a wrong failure report destroys a working install.
- **The installers read `runtime.json` for the pid and port** rather than
  guessing at the default. Guessing was wrong twice over: the server may be on
  any port, and on a host with a port-forward (the lima dev box) a probe of the
  default port reaches a *different machine's* server — which is exactly how a
  test of mine once started a run on the real board. They confirm the answer
  carries `app: "dt5742b-daq"`, and fall back to a process scan that refuses
  rather than kills when there is no usable record.
- **The bind pre-check must mirror uvicorn's socket options.** uvicorn sets
  `SO_REUSEADDR` unconditionally; a probe without it fails with `EADDRINUSE`
  while the previous server's connections sit in TIME_WAIT. That made `daq`
  refuse to start for minutes after every `daq stop` — "port 8800 is already in
  use" with nothing holding it — because the pre-check rejected a port uvicorn
  would have taken happily. `runtime.bind_probe()` is the one place that binds,
  and a smoke test fails if the option is dropped.
- **ctypes needs explicit `argtypes`/`restype` for every Win32 call.** Its
  default return type is a 32-bit int, which truncates the 64-bit `HANDLE` from
  `OpenProcess`; `WaitForSingleObject` on the truncated handle answers
  `WAIT_FAILED`, which read as "still running" — so `daq stop` reported failure
  about a process it had just killed, for every pid. `runtime._win_kernel32()`
  declares the signatures on its own `WinDLL`, not on the shared
  `ctypes.windll`. `tests/test_runtime.py` watches a child go from running to
  gone and runs on the Windows CI runner, where this is reachable.
- **`pythonw.exe` has no stdout and no stderr**, and that is how the detached
  Windows server runs. A `StreamHandler` on `None` fails on every record, so
  `logsetup` attaches a console handler only when a stream exists.
- **`daq status` reports the *server's* log path**, published in `/api/status`,
  not where the status command itself would write one. Those differ whenever the
  server was started with other options or is an older build — which is how a
  path got reported for a file that was never created.
- The server's interpreter can be uv's **managed** Python (`pythonw3.11.exe`),
  which lives outside the tool environment, so `install.ps1` searches both
  `uv tool dir` and `uv python dir` for it.
- `os.kill(pid, 0)` is the usual liveness test and is **catastrophic on
  Windows**: os.kill ignores the signal there and calls TerminateProcess, so
  asking "is it alive?" kills it. Use `runtime.process_alive()`.
- `daq stop` verifies the process actually died and clears the runtime file
  itself — on Windows the kill is TerminateProcess, so the server never gets to
  run its own cleanup — and names whatever still holds the port if one does.
- The **default port is 8800**, not 8000. 8000 collides with everything and was
  inside a Hyper-V reserved range on the Windows box, where it cannot be bound
  at all. `web/vite.config.ts` proxies to 8800 too — that is dev-server config
  only, so changing it needs no `static/` rebuild.
- CI runs `install.ps1` for real on `windows-latest` and `install.sh` on Linux,
  then starts the installed `daq` and fetches the UI and one asset. That is the
  only Windows verification available from a Mac; keep it working.

## Updating in place: `daq update`

- **The release's own installer does the installing.** `daq update` reads
  `releases/latest`, downloads that release's `install.sh`/`install.ps1`
  (BEFORE stopping anything, so a failed download changes nothing), refuses
  while recording, stops the server through `/api/shutdown`, and hands over.
  Do not reimplement the install in Python: every lesson in *Packaging and
  install* lives in those scripts.
- **The hand-over is platform-shaped.** POSIX `execve`s bash on the installer,
  so nothing of ours is running while uv replaces the env. Windows cannot do
  that - the running `daq.exe`/python live inside the env uv deletes - so it
  starts the installer in a NEW console (`CREATE_NEW_CONSOLE`) and exits; the
  installer waits on `DAQ_WAIT_PID`, then for every daq process under the uv
  dirs to vanish (the trampoline outlives python by a moment), before its own
  server check. That window closes itself on success and waits for Enter on
  failure.
- **Installer hooks, kept in both scripts:** `DAQ_WHEEL` (install this URL, no
  second API call), `DAQ_WAIT_PID`, `DAQ_RELAUNCH` (run `daq <args>` after a
  good install). Older installers ignore them, which only costs the relaunch.
- **Who restarts the server is decided by `runtime.json` `mode`.** `tray` and
  `launcher` (`daq` in the foreground) come back with their host/port/no-open;
  `serve` belongs to systemd/NSSM/a terminal and is left stopped with a message.
  A record without `mode` is a pre-update server: `pythonw` means tray.
- `/api/shutdown` closes the digitizer, then exits; it answers 409 while
  recording, which closes the race between our check and the stop. `daq stop`
  uses the same path (`launcher.stop_server`) and falls back to a signal only
  for servers older than the endpoint.
- **The UI notices a new bundle by itself.** `/api/status` lists `ui_assets`
  (the hashed files index.html loads, re-read when index.html's mtime moves so
  a `git pull` deployment works too); the page compares them with the files it
  was loaded from and shows "Update ready - Reload", held back while
  recording. No service worker - nothing to go stale. index.html is served
  `no-cache` and `/assets/*` `immutable`: with heuristic caching, a window
  opened after an update can load the old index.html naming deleted bundles,
  which is a blank page.
- **A reload must lose nothing.** Form state goes through
  `usePersistentState` (`local` = remembered last-used value, every window;
  `session` = this window's draft: run-number override, run note, offset
  being typed). Debounced server writes register with `flush.ts`, and Reload
  flushes them first. New UI state that should survive a reload uses the hook.
- `DAQ_UPDATE_URL` points the check at a stand-in for GitHub. The end-to-end
  recipe: build two wheels (the second with a bumped version and a renamed
  CSS asset), serve them plus `install.sh` and a `latest` JSON with
  `python -m http.server`, install the first with `UV_TOOL_DIR`/
  `UV_TOOL_BIN_DIR`/`XDG_STATE_HOME` pointed into a scratch dir, and run
  `daq update`. Shim `uv tool update-shell` to a no-op or it edits your shell
  rc. Verified that way on macOS; the Windows hand-over has been exercised
  only as far as its PowerShell wrapper under pwsh 7 - not yet on a real
  Windows box.

Run the server on the machine physically attached to the board.

**`server/daq/static/` is committed on purpose.** Deployments update by
`git pull` alone and never need Node. Always rebuild and commit it in the same
change as any `web/src` edit, or the deployed UI silently lags the server.

README is written for two audiences and both matter: an operator arriving cold
for a night shift, and someone installing or updating it from a long way away.
Keep the shift instructions short enough to follow at 2 a.m.

The in-app **?** button runs the same content as a three-step tour
(`web/src/quickuse.tsx`). Keep it and the README's "Taking a shift" section in
step — they are the same instructions in two presentations, and three steps is
the ceiling before people stop reading.

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

## UI conventions

- **Lockable settings (the house style).** A monochrome line-icon lock
  button (`LockToggle`, `currentColor` - it reads like the label, never as a
  highlighted control) sits to the LEFT of the setting's label and toggles
  it. Every hardware setting is lockable except the per-channel DC
  offsets, Digitize TR traces and
  Software trigger (never were; a `.lock-spacer` keeps their labels in
  line). Optional campaign settings are plain lockable rows - the old
  "uncheck to return to default" checkbox is gone. Locked: the control is greyed out but still shows the board's value -
  protection, not concealment. Locking never writes or resets anything, and
  one click unlocks. CSS: `.setting-row.lockable` (+ `.locked`),
  `.lock-toggle`. Keys: the setting key, `bank<N>:<key>` for bank settings,
  `calibration` for the calibrator.
  Locks live in the display prefs (`locks`), so every window and a reload
  agree; `LOCKED_BY_DEFAULT` (App.tsx) names the ones that start locked -
  today only the TR DC offset. The old global "lock everything" mode is
  gone.

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
- **The Playwright UI suite** (`web/tests/ui`, `npm run test:ui`) drives a
  real server started with **`DAQ_BACKEND=fake`** — `FakeBackend` behind the
  `DigitizerBackend` seam: settings stick exactly, events are synthetic. It
  is never the default and the server logs a warning when active, so a shift
  cannot mistake synthetic data for the real thing. The suite runs on port
  8801 with its state redirected under `web/test-results` (both LOCALAPPDATA
  and XDG_STATE_HOME), so it can never clobber a live daq's runtime record,
  sessions, or runs. Hardware-facing assertions poll `/api/config`, not the
  DOM — a DOM-only test would pass while the write silently failed. One
  worker, file order: the tests share the one fake board's state. CI runs it
  on ubuntu with `DAQ_TEST_SERVER_CMD` overriding the local uv launch.
- Nothing is persisted between runs of the process: the unit holds the settings
  and is read at open. Save/Load write and read an explicit file instead.
- The `Writer` interface is byte-compatible-WaveDump for v1; ROOT/HDF5 are meant
  to slot in behind it.

## Known-pending / gotchas

- `caen.py` has been driven end to end on serial 53364: open, identify,
  configure, arm, software-trigger, read, decode (8 ch x 1024 float samples,
  DRS4-corrected), stop, close. What is **not** verified is anything needing a
  real signal — waveform correctness, where the trigger actually lands in the
  record, and the absolute 0 V position of the DC-offset model (the span and
  sign are measured; the intercept rests on the nominal spec).
- WaveDump writer layout follows the docs but is **not byte-verified** against a
  real dump — check against one sample `.dat` before trusting downstream.
- **TR traces are decoded and written**, and the ROOT file uses maketree's
  INTERLEAVED slot order - verified against the actual converter source
  (tb_fnal_radical drs2root/maketree.cc line `totalIndex = realGroup*9 + i`):
  `channel[18]` slot = group*9 + ch_in_group, with the group's TR0 copy at
  in-group index 8 -> slots 8 and 17 are the TR/MCP copies, group 1's
  signal channels sit at 9-16. Amplitudes follow maketree too:
  window-referenced mV = 1000*(counts/4095 - 0.5). Do NOT "simplify" to
  16-signal-then-2-TR - an early writer did, and an analysis reading slot 8
  as the MCP would have gotten a signal channel (run_1.root of 2026-08-26
  is the one file in that old layout, in raw counts). The decoder still
  numbers signal channels 0-15 and TR copies 16/17 internally;
  RootWriter.root_slot() is the single meeting point of the two
  numberings, and each run's metadata records the mapping per channel
  (root_slot) plus a root_channel_layout description. Verified on serial
  53364: both groups digitize the same TR0 input, agreeing to ~10 counts -
  the DT5742B is 16+1, one shared TR0. The 2023 CERN campaign instead fed
  two physical MCPs into SIGNAL channels ch7 of each group (slots 7 and
  16, jwwetzel/RADiCAL ChannelConfig.h kMCP1/kMCP2) - a different cabling,
  same file convention. The WaveDump-format writers still drop TR (files
  only for channels 0-15); ROOT is the format that carries it.
- The UI has been used in a real browser and iterated on there; the remaining
  unknown is how it behaves with live data in it, not whether it renders.

## Roadmap

Verify against a pulser (waveforms, trigger position, byte-compare a run against
WaveDump) · write the x742 TR traces · ROOT/HDF5 writers behind `Writer` ·
in-app help · client/server over a real socket.

## Running: the server is durable, the window is a view

Built. `daq` is the only command an operator needs.

- **Closing a window can never affect a run.** There are no session tokens, no
  `beforeunload`, no close grace period — that whole mechanism was designed and
  then deleted, because making the server durable dissolves the problem it
  solved. Do not reintroduce it.
- `daq` reads `runtime.json` (`%LOCALAPPDATA%` / `$XDG_STATE_HOME`), probes
  `/api/status` on the recorded port, and **attaches** if a server answers —
  opening another window, never a second server. Otherwise it starts one.
- **The runtime file is a hint, never an authority.** It outlives crashes and
  can name a port something else has taken, so every read is confirmed by the
  `app: "dt5742b-daq"` field in `/api/status`. Deleting that field makes every
  running server invisible to `daq`; a smoke test guards it.
- `daq --serve` is the headless mode (lima, systemd, NSSM): no window, no tray,
  never exits on its own. `daq --open URL` views a remote server and starts
  nothing. `daq stop` / `daq status` work on the recorded server.
- **Windows detaches, POSIX stays in the foreground.** Windows has a tray icon
  to see and stop the server with, so the launcher detaches it via `pythonw.exe`
  and returns. Without a tray there would be no handle on a detached server, so
  elsewhere `daq` runs it in the foreground and Ctrl-C ends it.
- The tray is **Windows-only by dependency marker** (`pystray`, `pillow`). Linux
  is the headless case and must not grow an X dependency.
- The window is a **chromeless Chromium `--app` window** when Edge/Chrome is
  present, else the default browser. Cosmetic only — nothing depends on it.
- `_ThreadedServer` suppresses uvicorn's signal handlers and is for the **tray
  path only**. Using it for `--serve` would leave SIGTERM at its default
  disposition, so systemd's stop would skip the graceful shutdown.
- **The shutdown handler must not re-raise the signal.** uvicorn captures
  SIGINT/SIGTERM and re-delivers them to whatever handler was installed before
  it, so ours runs *after* uvicorn has already unwound. An earlier version then
  set `SIG_DFL` and re-killed the process to preserve a "killed by SIGTERM" exit
  status - which hung Ctrl-C on Windows: the log line appeared and nothing else
  happened. The handler now sets `server.should_exit`, clears the runtime file
  and **returns**, so `run()` finishes, the `finally` runs (it never did before)
  and the process exits 0. That is just as clean for systemd: `on-failure` does
  not restart on exit 0 any more than on SIGTERM.
- **The launcher narrates too.** `daq` used to log nothing at all: it looked for
  a running server, spawned a detached one and waited up to 30s in complete
  silence, which is indistinguishable from a hang. Every stage is a `step` now,
  and the wait reports progress every few seconds.
- **Detect a detached server that died rather than waiting out the timeout.**
  `start_server_detached` returns the `Popen` so `_wait_for_detached` can poll
  `proc.poll()`; a server that fails on startup is reported in a fraction of a
  second instead of after 30. Its own output goes nowhere the launching console
  can see, so the failure message names the log file and suggests `daq --serve`.
- **A second signal always exits**, via `os._exit(1)`. Whatever is wedged, a
  second Ctrl-C must end the process rather than leave a console sitting there.
- Tray behaviour is verified by `tests/test_tray.py`, which runs anywhere
  pystray imports (`pip install pystray pillow` locally) and on the Windows CI
  runner. It covers colour mapping, the icon at 16px, and menu shape — but the
  icon has never been *seen* by a test, and the quit dialog cannot be exercised
  headlessly at all.
