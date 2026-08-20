# DT5742B DAQ

Data acquisition for the CAEN **DT5742B** digitizer — 16+1 channels, 12-bit,
up to 5 GS/s, 1024 samples per event. The server owns the board; you drive it
from a browser.

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

---

# Install

**Live runs are on Windows.** Linux notes follow the Windows section.

The web UI is prebuilt and committed, so the DAQ machine needs **no Node.js**.

## Windows

**Prerequisites**

- CAEN digitizer libraries: CAENDigitizer, CAENComm, CAENVMELib
- CAEN's Windows USB driver for the DT5xxx
- Python 3.11+ (64-bit)
- Git

Install CAEN's software bundle first and confirm Windows sees the digitizer in
Device Manager before going further.

> **Bitness has to match.** 64-bit Python cannot load 32-bit CAEN DLLs or the
> reverse, and the error it gives is unhelpful. Use 64-bit for both.

```powershell
git clone git@github-coe:jneuhaus-coe/caen-daq-sw.git
cd caen-daq-sw\server
py -m pip install -e .
py -m daq --host 0.0.0.0
```

Then open `http://<host>:8000/`.

Runs are written to `%USERPROFILE%\daq-runs`. Set `DAQ_DATA_DIR` to move them.

### Keeping it running

Simplest is a shortcut or a `.bat` on the desktop:

```bat
@echo off
cd /d C:\caen-daq-sw\server
py -m daq --host 0.0.0.0
```

To have it start on boot and restart itself, register it as a service with
[NSSM](https://nssm.cc/): point it at your `python.exe`, with arguments
`-m daq --host 0.0.0.0` and *Startup directory* set to the `server` folder.
Task Scheduler ("At startup", "Run whether user is logged on or not") also
works and needs nothing extra installed.

### If the unit will not open on Windows

- Check Device Manager shows the digitizer with no warning triangle.
- Make sure the CAEN library `bin` directory is on `PATH` — that is how
  `CAENDigitizer.dll` gets found.
- Confirm Python is 64-bit: `py -c "import struct; print(struct.calcsize('P')*8)"`
  should print `64`.

## Linux

**Prerequisites**

- CAENDigitizer, CAENComm, CAENVMELib
- CAEN USB kernel driver (`CAENUSBdrvB`)
- udev rule for non-root access
- Python 3.11+

```bash
git clone git@github-coe:jneuhaus-coe/caen-daq-sw.git
cd caen-daq-sw/server
pip install -e .
python -m daq --host 0.0.0.0
```

Runs are written to `~/daq-runs`.

`CAENUSBdrvB` is an out-of-tree module built against one kernel version. **A
kernel upgrade leaves it unloadable**, which shows up as the unit failing to
open. Install it with `dkms` so it rebuilds itself, or pin the kernel.

To run it as a service:

```ini
# /etc/systemd/system/daq.service
[Unit]
Description=DT5742B DAQ server
After=network-online.target
Wants=network-online.target

[Service]
User=<you>
# Use the interpreter you ran `pip install -e .` with. If that was a virtualenv,
# point at its python — /usr/bin/python3 will not have the package.
ExecStart=/usr/bin/python3 -m daq --host 0.0.0.0
WorkingDirectory=/opt/caen-daq-sw/server
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now daq
journalctl -u daq -f          # logs
```

## Options

`--host 0.0.0.0` serves to the network; drop it to keep it on the machine only.
`--port` changes the port. `--no-open` skips opening the board at startup.

Restarting the server does not disturb the digitizer — it keeps its settings,
and they are read back on the next connect.

---

# Updating

**Windows**

```powershell
cd C:\caen-daq-sw
git pull
py -m pip install -e .\server     # only if dependencies changed
```

Then restart the server: close the window and re-run the shortcut, or
`Restart-Service` / restart the Task Scheduler task if you registered one.

**Linux**

```bash
cd caen-daq-sw
git pull
pip install -e ./server
sudo systemctl restart daq
```

Then **hard-refresh the browser** (Ctrl-Shift-R) so it picks up the new UI.

Things worth knowing across an update:

- **Your settings are not in the repo.** They live on the digitizer itself and
  are read back when the server opens it, so an update cannot lose them.
- **Recorded runs are not in the repo either** — they are under your data
  directory and are untouched by `git pull`.
- The UI bundle is committed, so `git pull` is enough; nothing needs building.
- If `git pull` reports a conflict in `server/daq/static/`, take the incoming
  version (`git checkout --theirs server/daq/static`) — it is generated output.

To report a problem from a distance, send the **Errors** panel contents, what
the badge says, and the server log — the console window on Windows, or
`journalctl -u daq -n 100` on Linux.

---

# For developers

```bash
cd server && pip install -e .        # editable install
python -m daq                        # http://127.0.0.1:8000/
python tests/test_smoke.py           # hardware-free smoke tests

cd web && npm install
npm run dev                          # UI hot-reload, proxies API/WS to :8000
npm run build                        # rebuild the bundle into server/daq/static
```

Commit the rebuilt `server/daq/static/` — that is what deployments get.

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
- [ ] Packaging for Windows
