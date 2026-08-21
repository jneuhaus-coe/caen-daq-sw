# DT5742B DAQ

Data acquisition for the CAEN **DT5742B** digitizer — 16+1 channels, 12-bit,
up to 5 GS/s, 1024 samples per event. The server owns the board; you drive it
from a browser.

Already installed? Skip to **[Taking a shift](#taking-a-shift)**.

---

# Install

## 1. CAEN Drivers

CAEN's own software is account-gated and cannot be installed by this repo, so that part
must come first.

**Windows** — install CAEN's bundle (CAENDigitizer, CAENComm, CAENVMELib) and
the Windows USB driver for the DT5xxx. Confirm Device Manager shows the
digitizer with no warning triangle before going any further.

**Linux** — the same three libraries, the `CAENUSBdrvB` kernel module, and a
udev rule for non-root access.

> `CAENUSBdrvB` is an out-of-tree module built against one kernel version. **A
> kernel upgrade leaves it unloadable**, which shows up as the unit failing to
> open. Install it with `dkms` so it rebuilds itself, or pin the kernel.

## 2. The DAQ

**Windows** — in PowerShell:

```powershell
irm https://raw.githubusercontent.com/jneuhaus-coe/caen-daq-sw/main/install.ps1 | iex
```

**Linux**:

```bash
curl -fsSL https://raw.githubusercontent.com/jneuhaus-coe/caen-daq-sw/main/install.sh | bash
```

This fetches the newest release along with its own private Python, so a
32-bit/64-bit driver library mismatch cannot happen. It finishes by checking for the
CAEN libraries and naming anything that is missing.

Open a new terminal afterwards so `daq` is on your PATH, then:

```
daq                    serve on 127.0.0.1:8000 (this machine only)
daq --host 0.0.0.0     serve to the network
daq --help             all options
```

Open `http://<daq-host>:8000/`. Runs are written to `%USERPROFILE%\daq-runs` on
Windows and `~/daq-runs` on Linux; set `DAQ_DATA_DIR` to move them.

If the installer warns that a different `daq` comes first on your PATH, deal with
it — that older copy is what will actually run, and every future update will look
like it silently did nothing.

**If it will not start on Windows** with *"an attempt was made to access a socket
in a way forbidden by its access permissions"*, port 8000 is inside a range
Windows has reserved for Hyper-V or WSL. Nothing is using it and nothing will
free it — pick a port outside those ranges:

```powershell
netsh interface ipv4 show excludedportrange protocol=tcp
daq --host 0.0.0.0 --port 8800
```

Use that port in the URL and in your `.bat` or service arguments too.

To install a specific version rather than the newest, set `DAQ_VERSION` to a tag
(`v0.1.0`) — or to `source` to build from the tip of `main` — before running the
one-liner.

## Keeping it running

**Windows** — simplest is a `.bat` on the desktop:

```bat
@echo off
"%USERPROFILE%\.local\bin\daq.exe" --host 0.0.0.0
```

To have it start on boot, use Task Scheduler ("At startup", "Run whether user is
logged on or not") — it needs nothing extra installed. [NSSM](https://nssm.cc/)
works too; point it at that same `daq.exe` with arguments `--host 0.0.0.0`.

If you register it either way, **stop it before updating**. Windows will not let
a running `daq.exe` be replaced, so the installer stops with an error rather than
half-updating.

**Linux** — as a user service:

```ini
# /etc/systemd/system/daq.service
[Unit]
Description=DT5742B DAQ server
After=network-online.target
Wants=network-online.target

[Service]
User=<you>
ExecStart=/home/<you>/.local/bin/daq --host 0.0.0.0
# on-failure, not always: it still recovers from a crash, but a deliberate
# shutdown stays down. `always` would fight the installer, which stops the
# server to update it — systemd would restart it mid-update and leave you
# running the old code with nothing to show that it happened.
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now daq
journalctl -u daq -f          # logs
```

Restarting the server does not disturb the digitizer — it keeps its settings,
and they are read back on the next connect. Auto-restart cannot rescue a
recording, though: the run is already truncated by the time the server comes
back, and it does not resume on its own.

## If the unit will not open

- **Windows** — check Device Manager shows the digitizer without a warning
  triangle, and that the CAEN library `bin` directory is on `PATH`; that is how
  `CAENDigitizer.dll` gets found. Re-running the installer re-checks both and
  reports what it finds, including whether the DLL is 32- or 64-bit.
- **Linux** — `lsmod | grep CAENUSBdrvB`. `OpenDigitizer` returning `-1` while
  `lsusb` shows the board means the USB driver is missing or unloadable.

---

# Updating

Run install command — it will stop the server first, then replace the installed
version.

```powershell
irm https://raw.githubusercontent.com/jneuhaus-coe/caen-daq-sw/main/install.ps1 | iex
```

```bash
curl -fsSL https://raw.githubusercontent.com/jneuhaus-coe/caen-daq-sw/main/install.sh | bash
```

It will refuse while a run is recording. **Your recorded runs are
untouched** — they live in your data directory, not anywhere the
installer writes.

Afterwards, **hard-refresh the browser** (Ctrl-Shift-R) so it picks up the new UI.

---

# Taking a shift

Open **http://\<daq-host\>:8000/** (on the DAQ machine itself,
<http://127.0.0.1:8000/>).

The **?** button at the top right walks you through this in three steps.

### 1. Check the unit is connected

Top left shows a green badge with the model and serial:

> ● DT5742B  S/N:53364

Red badge? See [When something is wrong](#when-something-is-wrong).

### 2. Watch before you record

Press **Start**. Nothing is written to disk — this is just the live view.

- **Channels** shows one averaged waveform per channel. A dashed **TRIG** line
  marks where the trigger sits in the record.
- **Trigger rate** shows triggers/second and a 60-second history.
- Channels flagged `DEAD` are flat; `CLIP` means the signal is hitting the top
  or bottom of the window — fix the DC offset before recording.

Give it a few seconds and check the rate is what you expect and the traces look
like signal, not noise or a flat line.

### 3. Record

Type a **Run name**, leave **Include timestamp** ticked, press **Record**.

The indicator turns red and shows the run name, elapsed time and event count.
Acquisition keeps running the whole time.

### 4. Stop

Press **Stop recording**. The live view keeps going, so you can check the next
configuration without stopping and restarting everything. **Stop** halts
acquisition entirely.

### 5. Collect the data

**Recorded Runs** lists every run with its time, channel count, event count and
size. **Download** gives you a zip of the whole run. The panel also shows the
folder on the server where runs live.

---

## What the settings mean

Every setting has a tooltip explaining what it does — hover the row. The ones
you are most likely to touch:

| Setting | Where | What it does |
|---|---|---|
| **Bank enabled** | Bank Settings | The DRS4 digitizes 8 channels at once, so channels enable per bank of 8, never individually. Turn off a bank you are not using. |
| **DC offset** | on each channel card | Moves that channel's baseline within the 1 Vpp window so the pulse fits without clipping. In volts. |
| **Post-trigger duration** | Unit Settings | How much of the record comes *after* the trigger. `0` puts the trigger at the very end, so you capture only the history before it. |
| **Sampling frequency** | Unit Settings | 1024 cells always, so this sets resolution *and* window length together: 204.8 ns at 5 GS/s, 1.37 µs at 750 MS/s. |
| **Fast trigger / External trigger** | Unit Settings | Where triggers come from: the TR0/TR1 inputs (low latency) or the front-panel TRG-IN. |

Settings are written to the unit and read back — what you see is what the
hardware confirmed, not what was requested. If the unit rounds or refuses a
value, a toast says so.

**Save** / **Load** in the Config panel write and read a settings file. Load also
accepts a CAEN `WaveDumpConfig.txt`.

---

## When something is wrong

**Badge is red, "No board".**
Press **Reconnect**. If that fails, check the unit is powered and its USB cable
is seated, then Reconnect again. Settings controls are disabled while
disconnected — that is deliberate, nothing can be sent.

**Rate is zero and no events arrive.**
The board is waiting for a trigger. Check the trigger source under Unit Settings
(*Fast trigger* for TR0/TR1, *External trigger* for TRG-IN) and that the signal
is actually reaching that connector.

**A channel reads `CLIP` or sits at the top of its window.**
Its DC offset is pushing the baseline out of range. Adjust **DC offset** on that
channel card until the trace sits inside the window.

**Errors panel shows `CAEN_DGTZ error -1`.**
A communication error. One on its own is usually transient and already retried.
Repeated failures with a red badge mean the driver or the connection is gone —
check the USB cable, then see [Install](#install).

**Nothing is being written.**
Check the indicator is red and counting. **Start** only watches; **Record**
writes.

**Reporting a problem from a distance.**
Send `daq --version`, the **Errors** panel contents, what the badge says, and
the server log — the console window on Windows, or `journalctl -u daq -n 100`
on Linux.

---

# For developers

```bash
git clone https://github.com/jneuhaus-coe/caen-daq-sw.git
cd caen-daq-sw

cd server && pip install -e ".[test]"   # editable install + test deps
python -m daq                        # http://127.0.0.1:8000/
python tests/test_smoke.py           # hardware-free smoke tests

cd web && npm install
npm run dev                          # UI hot-reload, proxies API/WS to :8000
npm run build                        # rebuild the bundle into server/daq/static
```

Commit the rebuilt `server/daq/static/` — it is what a source install gets, and
CI rebuilds it from `web/src` for releases either way.

## Cutting a release

```bash
./release.sh 0.2.0     # set the version, commit it, tag it, push
./release.sh           # tag and push whatever version is already set
```

`__version__` in `server/daq/__init__.py` is the single source of truth —
`pyproject.toml` reads it, and the tag is always `v$__version__`. `release.sh`
is what knows that, so nothing has to be kept in step by hand. It refuses on a
dirty tree, off `main`, or if the tag already exists.

The `Release` workflow builds the UI from source, builds the wheel, and refuses
to publish unless the tag matches `__version__` and the wheel actually contains
`daq/static/index.html`. It then attaches the wheel, the sdist and both install
scripts to the release, which is what the one-liners download.

`daq/static/` is not an importable package, so setuptools will drop it from the
wheel if `[tool.setuptools.package-data]` is ever broken — and the symptom is a
blank page rather than a build error. Both CI and the release workflow assert it
is there; leave those checks in place.

## Architecture

```
 browser UI ──HTTP+WebSocket──►  FastAPI server  ──►  AcquisitionEngine (own thread)
                                 (aggregates only)     │
                                                       ▼
                                             DigitizerBackend  ◄── the hardware seam
                                             └─ CaenBackend       (ctypes → libCAENDigitizer)
```

Readout runs on its own thread and hands the server only small **server-side
aggregates** (decimated averaged waveform + rate bins), so the display can never
throttle acquisition and the wire never carries the raw event torrent.

The board is the source of truth: settings are read off it at open, and every
write is read back before the UI shows it.

## Layout

```
server/
  daq/
    constants.py     board geometry, DRS4 frequencies, derived limits
    config.py        config model + WaveDump-seeded defaults
    configfile.py    save/load; reads our JSON and CAEN WaveDumpConfig.txt
    catalog.py       setting catalog with operator help; drives the UI
    backend/
      base.py        DigitizerBackend ABC + Event/BoardInfo
      caen.py        the real board via ctypes
    stats.py         rolling average + trigger-rate meter + decimation
    runs.py          recorded runs: create/list/zip/delete
    writer.py        Writer interface + WaveDump-compatible writer
    acquisition.py   threaded readout engine, recording, telemetry
    server.py        FastAPI REST + WebSocket + static
    static/          built web UI (generated — build from web/, don't edit)
  tests/             hardware-free smoke tests
web/src/             React + TypeScript UI
```

## Status

Runs against the real hardware: the unit opens and identifies, settings are
written and read back, and acquisition has been driven end to end with software
triggers — 8 channels × 1024 samples, DRS4-corrected.

Not yet verified against real signals: waveform correctness, where the trigger
actually lands, and the recorded file layout byte-for-byte against WaveDump.

- [x] Open, identify, configure, arm, read and decode
- [x] Settings read back from the unit; volts in the UI
- [x] Named runs with download and delete
- [ ] Verify against a pulser: waveforms, trigger position, file layout
- [ ] Write the x742 TR traces (`TR_*` files) — currently skipped
- [ ] ROOT / HDF5 writers behind the existing `Writer` interface
- [x] One-command install on Windows and Linux, published as a GitHub release
- [ ] Launcher: `daq` opens the UI and attaches to an already-running server, with a tray icon
