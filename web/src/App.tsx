import { useCallback, useEffect, useRef, useState } from "react";
import { api, openTelemetry } from "./api";
import type { Condition, DisplayPrefs, WaveMode } from "./api";
import { ConditionsPanel } from "./components/ConditionsPanel";
import { SessionsPanel } from "./components/SessionsPanel";
import { CalibrationPanel } from "./components/CalibrationPanel";
import type { BoardConfig, Catalog, Status, Telemetry, ZeroCal } from "./types";
import { ChannelGrid } from "./components/ChannelGrid";
import { BankPanel } from "./components/BankPanel";
import { SettingsList } from "./components/SettingsList";
import { Collapsible } from "./components/Collapsible";
import { ConfigPanel } from "./components/ConfigPanel";
import { Toasts, useToasts } from "./components/Toasts";
import { RunsPanel } from "./components/RunsPanel";
import { Elapsed } from "./components/Elapsed";
import { Tour } from "./components/Tour";
import { QUICK_USE } from "./quickuse";
import { describeChanges } from "./changes";
import { RateStrip } from "./components/RateStrip";
import { MiniWave } from "./components/MiniWave";
import { ConnectionBadge } from "./components/ConnectionBadge";
import { STATUS_POLL_MS } from "./types";
import { PERSIST_TRACES } from "./waveDensity";
import { BlurInput } from "./components/BlurInput";
import { TR_OFF_MID_DAC, fmtDacVolts, trAbsThresholdV, trThresholdDacForAbs,
         zeroCodeAt, zeroLine } from "./volts";

// Settings the operator tunes WHILE WATCHING the live plots - trigger and
// timing. Everything else in the unit catalog is campaign-tier: set once,
// then protected on the Experiment view where a mid-run hand cannot brush it.
const LIVE_UNIT_KEYS = new Set([
  "post_trigger", "trigger_edge", "external_trigger", "fast_trigger",
  "software_trigger", "fast_trigger_digitizing", "io_level",
]);

export function App() {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [config, setConfig] = useState<BoardConfig | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  // The open unit's per-board 0 V calibration (display only). Always loaded
  // when present: fetched whenever the status says it changed - a new
  // measurement, another unit, or the unit coming back.
  const [zc, setZc] = useState<ZeroCal | null>(null);
  const zcKey = status?.opened
    ? `${status.board.serial}|${status.zerocal?.measured_at ?? ""}` : "";
  useEffect(() => {
    if (!zcKey) { setZc(null); return; }
    let cancelled = false;
    api.zerocal().then((z) => { if (!cancelled) setZc(z); }).catch(() => {});
    return () => { cancelled = true; };
  }, [zcKey]);
  const [tele, setTele] = useState<Telemetry | null>(null);
  const [serverUp, setServerUp] = useState(true);
  const [reconnecting, setReconnecting] = useState(false);
  const [runName, setRunName] = useState("");
  // Empty = let the server infer the next number from the data directory.
  const [runNo, setRunNo] = useState("");
  const [stampRun, setStampRun] = useState(true);
  const [tour, setTour] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [runsKey, setRunsKey] = useState(0);   // bump to re-list runs
  // Per-channel waveform display ranges (volts). Persisted server-side so a
  // daq restart or a different browser comes back to the same view.
  const [yRanges, setYRanges] = useState<Record<number, [number, number]>>({});
  // Global channel controls: set the display window and the DC offset for all
  // 16 channels at once - handy when every channel sees a similar signal.
  const [allYMin, setAllYMin] = useState("");
  const [allYMax, setAllYMax] = useState("");
  // "avg": the 1 s rolling mean. "overlay": the last N single events piled
  // into a density picture. "scope": the newest single trace alone, fed by
  // free-running software triggers. Persisted with the display state.
  const [waveMode, setWaveMode] = useState<WaveMode>("avg");
  // Scope mode's software-trigger rate; committed via /api/scope.
  const [scopeHz, setScopeHz] = useState("2");
  // The scope's channel-trigger: "" = show every event; a channel number =
  // only events where that trace crosses the level refresh the display.
  const [scopeTrigCh, setScopeTrigCh] = useState("");
  const [scopeTrigMv, setScopeTrigMv] = useState("20");
  const [scopeTrigEdge, setScopeTrigEdge] = useState<"rising" | "falling">("falling");
  const [testN, setTestN] = useState("100");
  // Blank = record until stopped; a number = auto-close the run at N events.
  const [recMax, setRecMax] = useState("");
  // The run-notes dialog: Record opens it, and the note it collects lands in
  // run_metadata.json - what was tested, beam energy, the context no
  // register readback can supply. Cleared after each run starts: a note
  // describes ONE run, and a stale one silently attached to the next run
  // would be worse than none.
  const [recDialog, setRecDialog] = useState(false);
  const [recNote, setRecNote] = useState("");
  // The conditions snapshot shown in the confirm-setup dialog, fetched fresh
  // each time it opens so it reflects the server's truth, not tab state.
  const [recCond, setRecCond] = useState<Condition[]>([]);
  // Live = watch and operate; Experiment = campaign setup, conditions, and
  // everything you would hate to change by accident mid-campaign.
  const [view, setView] = useState<"live" | "experiment">("live");
  // The settings lock: lock everything with one button, unlock individual
  // settings one at a time - deliberate exceptions, wholesale protection.
  const [lockOn, setLockOn] = useState(false);
  const [lockOpen, setLockOpen] = useState<Set<string>>(new Set());
  const lockRef = useRef({ on: false, open: [] as string[] });
  lockRef.current = { on: lockOn, open: [...lockOpen] };
  // Existing run folders feed the run-name dropdown: picking one (with the
  // timestamp off) records INTO it - runs of an unchanged setup stay in one
  // campaign folder instead of scattering one directory per run.
  const [runDirs, setRunDirs] = useState<string[]>([]);
  // Bumped to wipe every channel's persistence pile: on recording start and
  // on calibration start, so each pile tells one coherent story - a
  // calibration's profile stays on screen for review until the next thing
  // that would muddle it begins.
  const [wipeEpoch, setWipeEpoch] = useState(0);
  const saveTimer = useRef<number | undefined>(undefined);
  const displayTimer = useRef<number | undefined>(undefined);
  // The config the unit last confirmed - what a change gets measured against.
  const confirmed = useRef<BoardConfig | null>(null);
  // The server's config revision this tab is based on. Sent with every push
  // so a tab holding history is refused instead of silently reverting the
  // unit; when the status poll shows the revision moved (another window, a
  // session apply, a reconnect), the tab refetches rather than goes stale.
  const cfgRev = useRef(0);
  const { toasts, push, dismiss } = useToasts();

  const loadOnce = useCallback(async () => {
    setLoadError(null);
    try {
      const [cat, cfg, st] = await Promise.all([api.catalog(), api.getConfig(), api.status()]);
      setCatalog(cat); setConfig(cfg); setStatus(st);
      confirmed.current = cfg;
      cfgRev.current = st.config_rev ?? 0;
    } catch (e) {
      // Leaving this to console.error left the page reading "Loading..." for
      // ever, with nothing on screen to say the server had not answered.
      setLoadError(e instanceof Error ? e.message : String(e));
    }
    // Display prefs restore on their own - they never touch the hardware.
    api.getDisplay().then((d) => {
      setYRanges(fromPrefs(d));
      // The display mode restores; the scope's trigger firing does NOT start
      // on page load - status.scope_hz says whether a scope is already live.
      setWaveMode(asWaveMode(d.wave_mode));
      setLockOn(!!d.lock_on);
      setLockOpen(new Set(Array.isArray(d.lock_open) ? d.lock_open : []));
    }).catch(() => {});
  }, []);

  useEffect(() => { loadOnce(); }, [loadOnce]);

  // Keep the run-name dropdown in step with what is on disk; runsKey bumps
  // whenever a recording starts or stops.
  useEffect(() => {
    api.runs().then((r) => setRunDirs(r.runs.map((x) => x.id))).catch(() => {});
  }, [runsKey]);

  const asWaveMode = (v: DisplayPrefs["wave_mode"]): WaveMode =>
    v === "overlay" || v === "scope" ? v : "avg";

  const fromPrefs = (d: DisplayPrefs): Record<number, [number, number]> => {
    const out: Record<number, [number, number]> = {};
    for (const [k, v] of Object.entries(d.y_ranges ?? {})) {
      // Window-referenced volts: nothing outside the 1 Vpp window is ever
      // readable, and ranges saved under the older input-referred frame
      // (up to +/-1 V) are silently retired by the same check.
      if (Array.isArray(v) && v.length === 2 && v[0] < v[1]
          && v[0] >= -0.501 && v[1] <= 0.501) {
        out[Number(k)] = [v[0], v[1]];
      }
    }
    return out;
  };

  const saveDisplay = (ranges: Record<number, [number, number]>,
                       mode: WaveMode) => {
    window.clearTimeout(displayTimer.current);
    displayTimer.current = window.setTimeout(() => {
      const y_ranges: Record<string, [number, number]> = {};
      for (const [k, v] of Object.entries(ranges)) y_ranges[k] = v;
      api.setDisplay({ y_ranges, wave_mode: mode,
                       lock_on: lockRef.current.on,
                       lock_open: lockRef.current.open }).catch(() => {});
    }, 400);
  };

  // The lock: keyed by setting ("post_trigger"), channel ("ch:5"), or
  // activity ("calibration"). Locking all clears every exception - the
  // whole point is that unlocks are deliberate, one at a time.
  const isLocked = (key: string) => lockOn && !lockOpen.has(key);
  const unlockOne = (key: string) => {
    setLockOpen((prev) => {
      const next = new Set(prev).add(key);
      lockRef.current = { on: lockOn, open: [...next] };
      saveDisplay(yRanges, waveMode);
      return next;
    });
  };
  const toggleLockAll = () => {
    if (lockOn && !window.confirm(
        "Unlock ALL settings? Individual unlocks are usually safer.")) return;
    const on = !lockOn;
    setLockOn(on);
    setLockOpen(new Set());
    lockRef.current = { on, open: [] };
    saveDisplay(yRanges, waveMode);
  };

  const applyYRanges = (next: Record<number, [number, number]>) => {
    setYRanges(next);
    saveDisplay(next, waveMode);
  };

  const changeWaveMode = (mode: WaveMode) => {
    // Entering scope starts the free-running software triggers; leaving it
    // stops them - the display mode and the trigger source are one gesture,
    // so a scope never silently fires with nobody watching it.
    if (mode === "scope" && waveMode !== "scope") {
      applyScope(scopeHz, scopeTrigCh, scopeTrigMv, scopeTrigEdge);
    } else if (mode !== "scope" && waveMode === "scope") {
      api.scope(false).then((r) => setStatus(r.status)).catch(() => {});
    }
    setWaveMode(mode);
    saveDisplay(yRanges, mode);
  };

  /** Push the whole scope state - rate and channel-trigger - in one call, so
   *  the server never holds a mix of old and new pieces. */
  const applyScope = async (hzRaw: string, trigCh: string, trigMv: string,
                            edge: "rising" | "falling") => {
    const hz = Math.min(20, Math.max(0.1, Number(hzRaw) || 2));
    setScopeHz(String(hz));
    const trigger = trigCh === "" ? null : {
      channel: Number(trigCh),
      level_mv: Math.min(500, Math.max(1, Number(trigMv) || 20)),
      edge,
    };
    try {
      const r = await api.scope(true, hz, trigger);
      setStatus(r.status);
      if (!r.ok) push("err", "Could not start the scope", [r.error ?? ""]);
    } catch (e) {
      push("err", "Could not start the scope",
           [e instanceof Error ? e.message : String(e)]);
    }
  };

  const changeYRange = (ch: number, range: [number, number] | null, all: boolean) => {
    const next = { ...yRanges };
    const targets = all && catalog
      ? Array.from({ length: catalog.geometry.num_channels }, (_, i) => i) : [ch];
    for (const t of targets) {
      if (range === null) delete next[t];
      else next[t] = range;
    }
    applyYRanges(next);
  };

  // ---- global (all-channel) controls ----
  const applyGlobalRange = () => {
    const lo = Number(allYMin), hi = Number(allYMax);
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo >= hi) {
      push("warn", "Enter a valid window", ["min must be below max"]);
      return;
    }
    changeYRange(0, [lo, hi], true);
  };
  const resetGlobalRange = () => {
    changeYRange(0, null, true);   // every channel back to the full window
    setAllYMin(""); setAllYMax("");
  };
  // Fit window to pulses - DISPLAY ONLY. Each channel's baseline and pulse
  // extremes, in the plots' input volts, from the single-event traces that
  // telemetry already ships (the last 300 events per channel; wiped with the
  // piles). The fit gives every channel the SAME height - the largest pulse
  // plus margin - and slides each window off centre only as far as its own
  // pulses need. No digitizer setting or recorded byte is touched.
  const extents = useRef<Record<number, {
    idx: number | null; ev: { b: number; lo: number; hi: number }[] }>>({});
  useEffect(() => { extents.current = {}; }, [wipeEpoch]);
  useEffect(() => {
    if (!tele || !catalog || !config) return;
    const g = catalog.geometry;
    for (let ch = 0; ch < g.num_channels; ch++) {
      const e = tele.channels[String(ch)];
      if (!e?.last || e.last_index == null) continue;
      const rec = (extents.current[ch] ??= { idx: null, ev: [] });
      if (rec.idx === e.last_index) continue;
      rec.idx = e.last_index;
      const line = zeroLine(ch, g, zc);
      const z = zeroCodeAt(line, e.dac ?? config.channels[ch].dc_offset, g);
      const toV = (c: number) => line.vScale * (c - z) * g.input_range_vpp / (g.adc_max + 1);
      const sorted = [...e.last].sort((a, b) => a - b);
      rec.ev.push({ b: toV(sorted[sorted.length >> 1]),
                    lo: toV(sorted[0]), hi: toV(sorted[sorted.length - 1]) });
      if (rec.ev.length > 300) rec.ev.shift();
    }
  }, [tele]);
  const fitWindows = () => {
    if (!catalog) return;
    const per: { ch: number; b: number; below: number; above: number }[] = [];
    for (let ch = 0; ch < catalog.geometry.num_channels; ch++) {
      const ev = extents.current[ch]?.ev ?? [];
      if (ev.length < 3) continue;
      const bs = ev.map((x) => x.b).sort((a, c) => a - c);
      const b = bs[bs.length >> 1];
      per.push({ ch, b,
                 below: Math.max(0, b - Math.min(...ev.map((x) => x.lo))),
                 above: Math.max(0, Math.max(...ev.map((x) => x.hi)) - b) });
    }
    if (!per.length) {
      push("warn", "No events to fit yet", ["Wait for a few triggers, then try again."]);
      return;
    }
    // Same height everywhere: the tallest pulse fills 80% of it.
    const H = Math.max(0.005, Math.max(...per.map((p) => p.below + p.above)) / 0.8);
    const m = 0.1 * H;
    const r4 = (v: number) => Math.round(v * 1e4) / 1e4;
    const Hr = r4(H);                 // one height, rounded once, for all
    const next = { ...yRanges };
    for (const p of per) {
      let lo = p.b - H / 2;                                   // centred...
      if (p.b - p.below - m < lo) lo = p.b - p.below - m;     // ...unless the pulse
      if (lo + H < p.b + p.above + m) lo = p.b + p.above + m - H;  // needs the room
      const lor = r4(lo);
      next[p.ch] = [lor, r4(lor + Hr)];
    }
    applyYRanges(next);
    push("ok", "Plot windows fitted to pulses",
         [`${(H * 1000).toFixed(1)} mV tall on ${per.length} channels - display only; "reset" restores full scale`]);
  };

  const catalogRef = useRef<Catalog | null>(null);
  catalogRef.current = catalog;

  useEffect(() => openTelemetry(setTele), []);

  // Poll status: the board can vanish (unit switched off) or come back at any
  // time, and only /api/status actually pokes it.
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const st = await api.status();
        if (cancelled) return;
        setStatus(st); setServerUp(true);
        // The config moved underneath this tab - another window, a session
        // apply, a server restart. Refetch instead of quietly going stale:
        // a stale tab once pushed its whole old snapshot and reverted every
        // offset and name on the unit.
        if (st.config_rev != null && st.config_rev !== cfgRev.current) {
          cfgRev.current = st.config_rev;
          const cfg = await api.getConfig();
          if (!cancelled) { setConfig(cfg); confirmed.current = cfg; }
        }
      } catch {
        if (!cancelled) setServerUp(false);
      }
    };
    tick();
    const id = window.setInterval(tick, STATUS_POLL_MS);
    return () => { cancelled = true; window.clearInterval(id); };
  }, []);

  // Adopt a status answer from an action, and the config with it when the
  // revision moved. Start/Stop re-adopt the board's config server-side; a
  // write sent before the next status poll then carried the old revision
  // and was refused as stale - the field silently snapped back.
  const adoptStatus = async (st: Status) => {
    setStatus(st);
    if (st.config_rev != null && st.config_rev !== cfgRev.current) {
      cfgRev.current = st.config_rev;
      const cfg = await api.getConfig();
      setConfig(cfg); confirmed.current = cfg;
    }
  };

  const pushConfig = (next: BoardConfig) => {
    setConfig(next);                       // optimistic, for input responsiveness
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      // Whatever the board reports wins - a rejected write must not leave the
      // UI showing a value the hardware never took.
      api.setConfig(next, cfgRev.current)
        .then((r) => {
          if (r.config_rev != null) cfgRev.current = r.config_rev;
          setConfig(r.config);
          if (r.stale) {
            // This tab's config predates the server's state; the write was
            // refused and the fields now show the current truth.
            confirmed.current = r.config;
            push("warn", "Settings changed elsewhere", r.errors ?? []);
            return;
          }
          const prev = confirmed.current ?? r.config;
          const lines = catalogRef.current
            ? describeChanges(prev, r.config, next, catalogRef.current) : [];
          confirmed.current = r.config;
          if (r.connected === false) {
            // Nothing was sent; the fields have just snapped back.
            push("warn", "No unit connected", ["Nothing was sent. Reconnect, then try again."]);
          } else if (r.errors?.length) {
            setStatus((st) => st && { ...st, errors: [...st.errors, ...r.errors] });
            push("err", "Unit rejected a setting", r.errors);
          } else if (lines.length) {
            push("ok", "Applied and read back from unit", lines);
          }
        })
        .catch(() => push("err", "Could not reach the DAQ server"));
    }, 250);
  };
  const updateBoard = (key: string, value: any) =>
    config && pushConfig({ ...config, [key]: value });
  const updateGroup = (g: number, key: string, value: any) => {
    if (!config) return;
    const groups = config.groups.map((gc, i) => (i === g ? { ...gc, [key]: value } : gc));
    pushConfig({ ...config, groups });
  };
  // The DT5742B has ONE TR0 split to both mezzanines; each keeps its own
  // registers, but there is no sensible reason for them to differ, so the
  // TR0 panel writes every bank at once. Divergence (an old config, a raw
  // register poke) is surfaced below the panel, never silently masked.
  // RAW threshold semantics (operator's choice, 2026-08-28): threshold and
  // offset are independent absolute levels on the same volt scale, and the
  // trigger's effective depth is their difference - shown live in the card's
  // "vs offset" readout, never silently compensated.
  const updateTrBoth = (key: string, value: any) => {
    if (!config) return;
    pushConfig({ ...config, groups: config.groups.map((gc) => ({ ...gc, [key]: value })) });
  };
  const updateChannel = (ch: number, patch: Partial<BoardConfig["channels"][number]>) => {
    if (!config) return;
    const channels = config.channels.map((c, i) => (i === ch ? { ...c, ...patch } : c));
    pushConfig({ ...config, channels });
  };

  const failed = (what: string) => (e: unknown) =>
    push("err", what, [e instanceof Error ? e.message : String(e)]);

  const start = async () => {
    try {
      const st = await api.start();
      await adoptStatus(st);
      // The server refuses rather than raising, so a 200 does not mean it
      // started. The reason is already in the errors panel; the toast points
      // at it instead of leaving the button looking inert.
      if (!st.started) {
        const why = st.errors.slice(-2);
        push("err", "Acquisition did not start",
             why.length ? why : ["See the Errors panel."]);
      }
    } catch (e) {
      failed("Could not start acquisition")(e);
    }
  };
  const stop = async () => {
    try {
      await adoptStatus(await api.stop());
    } catch (e) {
      failed("Could not stop acquisition")(e);
    }
  };
  const fireTest = async () => {
    // The bench source: the 742 has no channel self-trigger, so with nothing
    // on TRG-IN/TR0 this is how events happen. Starts acquisition on its own.
    try {
      const n = Math.max(1, Math.round(Number(testN) || 100));
      const r = await api.trigger(n, 10);
      await adoptStatus(r.status);
      if (!r.ok) push("err", "Could not fire test triggers", [r.error ?? ""]);
      else push("ok", `Firing ${r.queued} test triggers at 10 Hz`);
    } catch (e) {
      failed("Could not fire test triggers")(e);
    }
  };
  // Opening the record dialog fetches the conditions fresh, so the
  // confirm-setup review shows the server's truth at this moment.
  const openRecDialog = () => {
    api.conditions().then((r) => setRecCond(r.items)).catch(() => setRecCond([]));
    setRecDialog(true);
  };

  // Timestamp OFF and the name matches a folder on disk: this recording
  // joins that folder (run_<N>.root added alongside) instead of failing on
  // the clash or minting yet another directory.
  const intoExisting = !stampRun && runDirs.includes(runName.trim());

  const startRec = async () => {
    setRecDialog(false);
    try {
      const n = runNo.trim() === "" ? null : Number(runNo);
      const m = recMax.trim() === "" ? null : Number(recMax);
      const r = await api.recStart(runName, stampRun,
                                   Number.isFinite(n as number) ? n : null,
                                   Number.isFinite(m as number) ? m : null,
                                   recNote.trim(), intoExisting);
      setStatus(r.status);
      if (!r.ok) push("err", "Could not start recording", [r.error ?? "no reason given"]);
      else {
        push("ok", "Recording", [`${r.run}`]);
        setRunNo("");            // the next number is inferred again
        setRecNote("");          // a note describes one run, never the next
        setRunsKey((k) => k + 1);
      }
    } catch (e) {
      failed("Could not start recording")(e);
    }
  };
  const stopRec = async () => {
    try {
      const r = await api.recStop();
      setStatus(r.status);
      push(r.ok ? "ok" : "warn",
           r.ok ? "Recording stopped" : "Nothing was recording",
           [r.ok ? `${r.run}` : (r.error ?? "")]);
      setRunsKey((k) => k + 1);
    } catch (e) {
      failed("Could not stop the recording")(e);
    }
  };
  const reconnect = async () => {
    setReconnecting(true);
    try {
      setStatus(await api.reconnect());
      setServerUp(true);
    } catch {
      setServerUp(false);
    } finally {
      setReconnecting(false);
    }
  };

  // Recording start wipes the persistence piles (calibration start does too,
  // via the panel's onStarted).
  const recordingNow = tele?.recording ?? status?.recording ?? false;
  const prevRecording = useRef(false);
  useEffect(() => {
    if (recordingNow && !prevRecording.current) setWipeEpoch((e) => e + 1);
    prevRecording.current = recordingNow;
  }, [recordingNow]);

  if (!catalog || !config) {
    return (
      <div className="loading">
        {loadError ? (
          <>
            <p>Could not reach the DAQ server.</p>
            <p className="mono err">{loadError}</p>
            <p className="muted">
              Check it is running (<code>daq status</code>), then try again.
            </p>
            <button className="primary" onClick={loadOnce}>Retry</button>
          </>
        ) : "Loading\u2026"}
      </div>
    );
  }
  const running = tele?.running ?? status?.running ?? false;
  const connected = serverUp && !!status?.opened;
  const recording = recordingNow;
  const acqState = recording ? "recording" : running ? "acquiring" : "idle";

  return (
    <div className="app">
      <header>
        <h1>DT5742B DAQ</h1>
        <nav className="view-tabs" role="tablist" aria-label="View">
          <button role="tab" aria-selected={view === "live"}
            className={view === "live" ? "on" : ""}
            onClick={() => setView("live")}>Live</button>
          <button role="tab" aria-selected={view === "experiment"}
            className={view === "experiment" ? "on" : ""}
            title="Campaign setup: the settings and experiment facts that stay fixed for a whole campaign"
            onClick={() => setView("experiment")}>Experiment</button>
        </nav>
        <button className={"lock-all" + (lockOn ? " on" : "")}
          title={lockOn
            ? "Settings are LOCKED. Unlock individual settings with their own lock icons; click here to unlock everything."
            : "Lock every hardware setting against accidental edits. Unlock them one at a time afterwards."}
          onClick={toggleLockAll}>
          {lockOn ? "🔒 LOCKED" : "🔓 LOCK"}
        </button>
        <ConnectionBadge status={status} serverUp={serverUp}
          busy={reconnecting} onReconnect={reconnect} />
        {/* Acquisition lives beside the connection state, away from the
            Record cluster: enabling it watches, and only Record writes -
            keeping the two apart is what stops "for N ev" reading as an
            acquisition option. */}
        <div className="acq-group">
          {!running ? (
            <button className="primary" onClick={start} disabled={!connected}
              title={connected ? "Watch live — nothing is written to disk"
                               : "No unit connected"}>
              Enable Acquisition
            </button>
          ) : null}
          {/* Hidden while recording: disabling acquisition there would end the
              run, and "Stop recording" is the button you actually want. */}
          {running && !recording ? (
            <button onClick={stop}>Disable Acquisition</button>
          ) : null}
        </div>
        <span className={"pill state " + acqState}>{acqState}</span>
        <span className="pill mono">{tele?.events_seen ?? 0} events</span>
        <div className="spacer" />
        <div className="run-controls">
          <div className={"rec-group" + (recording ? " on" : "")}>
            {recording ? (
              <>
                <span className="rec-dot" />
                <span className="rec-name mono">{tele?.run_id ?? status?.run_id}</span>
                <span className="rec-count mono">
                  <Elapsed since={tele?.run_started ?? status?.run_started ?? null} />
                  {" · "}{tele?.recorded ?? 0} ev
                </span>
                <button className="danger" onClick={stopRec}>Stop recording</button>
              </>
            ) : (
              <>
                <label className="rec-label" htmlFor="runname">Run name</label>
                <input id="runname" className="rec-input" placeholder="e.g. cosmics" value={runName}
                  disabled={!connected} list="run-dirs"
                  title="Pick an existing folder (with the timestamp off) to add this run to it, or type a new name for a new folder"
                  onChange={(e) => setRunName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") openRecDialog(); }} />
                <datalist id="run-dirs">
                  {runDirs.map((d) => <option key={d} value={d} />)}
                </datalist>
                <label className="rec-label" htmlFor="runno"
                  title="The analysis-facing run number (run_N.root). Prefilled with one past the highest number in the data directory; type to override.">
                  Run #
                </label>
                <input id="runno" className="rec-input rec-no" type="number" min={1}
                  placeholder={String(status?.next_run_number ?? "")}
                  value={runNo} disabled={!connected}
                  onChange={(e) => setRunNo(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") openRecDialog(); }} />
                <label className="rec-label" htmlFor="recmax"
                  title="Stop the recording automatically after this many events. Blank = record until stopped. Acquisition keeps running either way.">
                  for
                </label>
                <input id="recmax" className="rec-input rec-no" type="number" min={1}
                  placeholder="&#8734; ev" value={recMax} disabled={!connected}
                  onChange={(e) => setRecMax(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") openRecDialog(); }} />
                <label className="rec-stamp" title="Append the date and time, so runs of the same name never collide">
                  <input type="checkbox" checked={stampRun} disabled={!connected}
                    onChange={(e) => setStampRun(e.target.checked)} />
                  Include timestamp
                </label>
                <button className="record" onClick={openRecDialog}
                  disabled={!connected}
                  title="Start writing this run to disk (asks for a run note first)">
                  <span className="rec-dot" />Record
                </button>
              </>
            )}
          </div>
        </div>
        <button className="help-btn" onClick={() => setTour(true)}
          title="Quick use" aria-label="Quick use">?</button>
      </header>

      <div className="body">
        <fieldset className="hw-lock" disabled={!connected}
          title={connected ? undefined : "No unit connected"}>
        {view === "experiment" ? (
          <main className="experiment">
            <div className="exp-grid">
              <div className="exp-col">
                <div className="card">
                  <h2>Campaign Settings <span className="sub">set once, then lock</span></h2>
                  <SettingsList
                    defs={catalog.unit.filter((d) => !LIVE_UNIT_KEYS.has(d.key))}
                    geom={catalog.geometry}
                    get={(k) => (config as any)[k]} onChange={updateBoard}
                    locked={isLocked} onUnlock={unlockOne} />
                </div>
                <Collapsible title="Bank Settings" defaultOpen>
                  <BankPanel catalog={catalog} config={config}
                    onGroupChange={updateGroup}
                    locked={isLocked} onUnlock={unlockOne} />
                </Collapsible>
              </div>
              <div className="exp-col">
                <ConditionsPanel onError={(t, l) => push("err", t, l)} />
                <SessionsPanel
                  recording={recording}
                  onSaved={(name) => push("ok", `Session "${name}" saved`)}
                  onError={(title, lines) => push("err", title, lines)}
                  onApplied={(cfg, display, errors, isConn, name) => {
                    setConfig(cfg); confirmed.current = cfg;
                    setYRanges(fromPrefs(display));
                    setWaveMode(asWaveMode(display.wave_mode));
                    if (!isConn) {
                      push("warn", `Session "${name}": display restored`,
                           ["No unit connected - hardware settings were not written."]);
                    } else if (errors.length) {
                      push("err", `Session "${name}" applied with errors`, errors);
                    } else {
                      push("ok", `Session "${name}" applied and read back from unit`);
                    }
                  }} />
                <ConfigPanel
                  onReset={async () => {
                    try {
                      const r = await api.resetDefault();
                      setConfig(r.config); confirmed.current = r.config;
                      if (r.connected === false) {
                        push("warn", "No unit connected", ["Nothing was sent."]);
                      } else if (r.errors?.length) {
                        push("err", "Unit rejected part of the reset", r.errors);
                      } else {
                        push("ok", "Defaults applied and read back from unit");
                      }
                    } catch (e) {
                      failed("Could not reset the settings")(e);
                    }
                  }}
                  onLoaded={({ config: cfg, notes, errors, restart, connected: up, running: isRunning }) => {
                    setConfig(cfg); confirmed.current = cfg;
                    if (!up) {
                      push("warn", "No unit connected", ["The file was read, but nothing was sent."]);
                    } else if (errors.length) {
                      push("err", "Unit rejected a setting from the file",
                           [...errors, ...notes]);
                    } else {
                      push(notes.length ? "warn" : "ok",
                           "Config loaded and read back from unit", notes);
                    }
                    if (restart.length && isRunning) {
                      const what = restart.join(", ");
                      if (confirm(`${what} only take effect when the unit is re-armed.\n\nRestart acquisition now?`)) {
                        api.stop().then(() => api.start()).then(setStatus)
                          .catch(failed("Could not re-arm the unit"));
                      }
                    }
                  }} />
              </div>
            </div>
          </main>
        ) : (
        <main>
          <div className="grid-head">
            <h2>Channels <span className="sub">
              {waveMode === "avg"
                ? `all 16 · avg ${tele?.avg_window_s ?? 1}s window · click a title to rename`
                : waveMode === "scope"
                ? `all 16 · newest single trace, full resolution · click a title to rename`
                : `all 16 · last ${PERSIST_TRACES} events, density-shaded · click a title to rename`}
            </span></h2>
            <div className="wave-mode" role="group" aria-label="Waveform display mode">
              <button className={waveMode === "avg" ? "on" : ""}
                title={`Rolling mean of the last ${tele?.avg_window_s ?? 1}s of events`}
                onClick={() => changeWaveMode("avg")}>Avg</button>
              <button className={waveMode === "overlay" ? "on" : ""}
                title={`The last ${PERSIST_TRACES} single events stacked, brightness = how often a path is taken`}
                onClick={() => changeWaveMode("overlay")}>Overlay</button>
              <button className={waveMode === "scope" ? "on" : ""}
                disabled={!connected}
                title="One full-resolution trace at a time, fed by free-running software triggers - for studying the noise on a line"
                onClick={() => changeWaveMode("scope")}>Scope</button>
              {waveMode === "scope" ? (
                <>
                  <label className="scope-rate" title="Software-trigger rate, 0.1-20 Hz">
                    <input type="number" min={0.1} max={20} step={0.1} value={scopeHz}
                      onChange={(e) => setScopeHz(e.target.value)}
                      onBlur={(e) => applyScope(e.target.value, scopeTrigCh, scopeTrigMv, scopeTrigEdge)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter")
                          applyScope((e.target as HTMLInputElement).value,
                                     scopeTrigCh, scopeTrigMv, scopeTrigEdge);
                      }} />
                    Hz
                  </label>
                  <span className="scope-trig"
                    title="Software display trigger: only events where this channel crosses the level (vs its own baseline) refresh the traces. The x742 has no hardware channel trigger, so this samples the line at the scope rate - features present in most windows show; rare pulses still need the signal on TR0.">
                    trig
                    <select value={scopeTrigCh}
                      onChange={(e) => {
                        setScopeTrigCh(e.target.value);
                        applyScope(scopeHz, e.target.value, scopeTrigMv, scopeTrigEdge);
                      }}>
                      <option value="">any</option>
                      {Array.from({ length: catalog.geometry.num_channels }, (_, i) => (
                        <option key={i} value={i}>CH {i}</option>
                      ))}
                      <option value={16}>TR0</option>
                    </select>
                    {scopeTrigCh !== "" ? (
                      <>
                        <input type="number" min={1} max={500} value={scopeTrigMv}
                          onChange={(e) => setScopeTrigMv(e.target.value)}
                          onBlur={(e) => applyScope(scopeHz, scopeTrigCh, e.target.value, scopeTrigEdge)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter")
                              applyScope(scopeHz, scopeTrigCh,
                                         (e.target as HTMLInputElement).value, scopeTrigEdge);
                          }} />
                        mV
                        <button
                          title={scopeTrigEdge === "falling"
                            ? "Triggering on a dip below baseline - click for rising"
                            : "Triggering on a rise above baseline - click for falling"}
                          onClick={() => {
                            const next = scopeTrigEdge === "falling" ? "rising" : "falling";
                            setScopeTrigEdge(next);
                            applyScope(scopeHz, scopeTrigCh, scopeTrigMv, next);
                          }}>
                          {scopeTrigEdge === "falling" ? "↘" : "↗"}
                        </button>
                      </>
                    ) : null}
                  </span>
                </>
              ) : null}
            </div>
            <div className="legend">
              <span className="lg live" title="Showing at least its noise floor - a quiet channel seeing only dark counts is live, not dead">live</span>
              <span className="lg dead" title="A single event flatter than any real noise floor: the electronics are silent - check the cable, not the source">dead</span>
              <span className="lg clip" title="The average touches an ADC rail - part of the signal is outside the window">clip</span>
              <span className="lg off">bank off</span>
            </div>
          </div>
          <div className="chan-global"
            title="Apply to all 16 channels at once - handy when every channel sees a similar signal">
            <span className="cg-label">All channels</span>
            <span className="cg-group" title="Display window (volts) for every channel's plot">
              window
              <input type="number" step={0.01} className="cg-num" placeholder="-0.5"
                value={allYMin} onChange={(e) => setAllYMin(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") applyGlobalRange(); }} />
              to
              <input type="number" step={0.01} className="cg-num" placeholder="+0.5"
                value={allYMax} onChange={(e) => setAllYMax(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") applyGlobalRange(); }} />
              V
              <button onClick={applyGlobalRange}>set</button>
              <button onClick={resetGlobalRange}
                title="Reset every channel's plot to the full window">reset</button>
            </span>
            <button className="cg-fit" onClick={fitWindows}
              title="Display only: sets every channel plot's vertical range to the same height, each baseline shifted just enough to fit the largest recent pulses with margin. Changes no digitizer setting and no recorded data. 'reset' restores full scale.">
              Fit window to pulses
            </button>
          </div>
          <ChannelGrid catalog={catalog} config={config} tele={tele} zc={zc}
            onDcOffset={(ch, dac) => updateChannel(ch, { dc_offset: dac })}
            onName={(ch, name) => updateChannel(ch, { name })}
            yRanges={yRanges} onYRange={changeYRange} waveMode={waveMode}
            clearEpoch={wipeEpoch}
            locked={isLocked} onUnlock={unlockOne} />
        </main>
        )}

        {view === "live" ? (
        <aside>
          {(() => {
            // The digitized TR0 trace, when TR digitizing is on: the same
            // signal both groups see, shown once (group 0's copy, else 1's).
            const trCh = tele?.channels["16"] ? 16 : tele?.channels["17"] ? 17 : null;
            const tr = trCh != null ? tele!.channels[String(trCh)] : null;
            if (!config.fast_trigger_digitizing || !tr) return null;
            // Trace in TR0 input volts (x2 attenuator, offset per Tab. 9.1).
            // The trigger line is drawn ONLY at offset 0x8000, the one case
            // UM4270 sec 9.8.3 gives the threshold in volts for; elsewhere
            // CAEN states there is no formula, so there is no line.
            const off = config.groups[trCh! - 16].fast_trigger_dc_offset;
            const trLine = zeroLine(trCh!, catalog.geometry, zc);
            const thr = config.groups[trCh! - 16].fast_trigger_threshold;
            const markers = off === TR_OFF_MID_DAC
              ? [{ v: trAbsThresholdV(thr), label: "trigger", color: "#f85149" }]
              : [];
            return (
              <div className="card">
                <h2>TR0 <span className="sub">fast trigger</span></h2>
                <MiniWave wave={tr.wave}
                  geom={catalog.geometry}
                  windowNs={tele ? tele.sample_period_ns * tele.record_length : undefined}
                  postTriggerPct={config.post_trigger}
                  color="#e3b341" height={110}
                  markers={markers} vScale={trLine.vScale}
                  zeroCode={zeroCodeAt(trLine, off, catalog.geometry)}
                  offsetDac={off} offsetSlope={trLine.s} waveDac={tr.dac}
                  yRange={yRanges[trCh!]}
                  onYRange={(range, all) => changeYRange(trCh!, range, all)}
                  mode={waveMode} lastWave={tr.last} lastId={tr.last_index}
                  clearEpoch={wipeEpoch} />
              </div>
            );
          })()}
          <Collapsible title="TR0 Trigger" defaultOpen>
            {(() => {
              // The TR offset field stays on CAEN's scale (Tab. 9.1), NOT the
              // 0 V calibration: 0 is midscale 0x8000, the reference the
              // threshold arithmetic is defined against. Through the
              // calibration, "0" landed at 33576 and the threshold lost its
              // meaning. The TR0 TRACE is still calibrated.
              const offDefs = catalog.bank.filter((d) =>
                d.key === "fast_trigger_dc_offset");
              const [g0, g1] = config.groups;
              const diverged = ["fast_trigger_threshold", "fast_trigger_dc_offset"]
                .some((k) => (g0 as any)[k] !== (g1 as any)[k]);
              const offMid = g0.fast_trigger_dc_offset === TR_OFF_MID_DAC;
              return (
                <>
                  <div className="setting-row"
                    title={"Trigger level in volts at the TR0 input, relative to its ground (shield), per CAEN's worked examples (V1742 manual rev 6 sec 5.15, in docs/): with the TR DC offset at 0x8000, DAC 0x6666 = 0 V and 13.2 DAC steps per mV - a NIM signal (0 to -800 mV) triggers at half swing with 0x51C6 = -400 mV. A -140 mV falling trigger is simply -0.140 here. CAEN states no simple formula exists at other offsets - keep the offset at midscale.\n\nOne DAC step is 0.0758 mV; the field shows as many digits as it takes to name the exact register word.\n\nDAC word: " + g0.fast_trigger_threshold + "\n\nCAEN_DGTZ_SetGroupFastTriggerThreshold"}>
                    <label>TR threshold <span className="muted">at input</span></label>
                    <span className="field">
                      {/* min sets the arrow keys' step base, so it must sit on
                          the step grid: -1.986 made them walk -0.001, 0.004,
                          0.009... DAC 0..65535 spans -1.9859..+2.9789 V. */}
                      <BlurInput type="number" step={0.001} min={-1.985} max={2.978}
                        selectOnFocus
                        value={fmtDacVolts(g0.fast_trigger_threshold,
                                           trAbsThresholdV, trThresholdDacForAbs)}
                        disabled={isLocked("fast_trigger_threshold")}
                        onCommit={(v) => {
                          updateTrBoth("fast_trigger_threshold",
                            trThresholdDacForAbs(Number(v) || 0));
                        }} />
                      <span className="unit">V</span>
                    </span>
                    {isLocked("fast_trigger_threshold") ? (
                      <button className="lock-chip"
                        title="Locked. Click to unlock just the TR threshold."
                        onClick={() => unlockOne("fast_trigger_threshold")}>🔒</button>
                    ) : null}
                    {!offMid ? (
                      <span className="muted tr-rel-note" title="V1742 manual rev 6 sec 5.15: the threshold volts are only calibrated with the TR DC offset at midscale (0x8000); CAEN provides no formula for other offsets.">
                        ⚠ offset not at midscale
                      </span>
                    ) : null}
                  </div>
                  <SettingsList defs={offDefs} geom={catalog.geometry}
                    get={(k) => (g0 as any)[k]} onChange={updateTrBoth}
                    locked={isLocked} onUnlock={unlockOne} />
                  {diverged ? (
                    <div className="tr-diverged">
                      The two banks' TR0 registers differ (bank 1 has its own
                      values). Editing here writes both;{" "}
                      <button onClick={() => {
                        const groups = config.groups.map((gc) => ({
                          ...gc,
                          fast_trigger_threshold: g0.fast_trigger_threshold,
                          fast_trigger_dc_offset: g0.fast_trigger_dc_offset,
                        }));
                        pushConfig({ ...config, groups });
                      }}>sync bank 1 to bank 0</button>
                    </div>
                  ) : null}
                  <p className="muted">
                    One input, split to both banks; this panel writes both
                    together. Threshold volts are calibrated only with the
                    offset at midscale (V1742 manual rev 6 sec 5.15, in docs/).
                  </p>
                </>
              );
            })()}
          </Collapsible>
          <div className="card">
            <h2>Trigger rate</h2>
            <RateStrip tele={tele} />
            <div className="test-trigger"
              title="Software triggers - the bench source when nothing external can trigger the board. Starts acquisition if it is not running.">
              <button onClick={fireTest} disabled={!connected}>Fire</button>
              <input type="number" min={1} value={testN}
                disabled={!connected}
                onChange={(e) => setTestN(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") fireTest(); }} />
              <span className="muted">test triggers @ 10 Hz</span>
              {status?.sw_triggers_pending ? (
                <span className="pending mono">{status.sw_triggers_pending} left</span>
              ) : null}
            </div>
          </div>
          <Collapsible title="Trigger &amp; Timing" defaultOpen>
            <div className="trig-guide">
              <p><b>The board fires when ANY enabled source crosses its
                level</b> (logical OR of the sources below).</p>
              <p className="trig-warn">The 16 signal channels <b>cannot</b>
                trigger the board. To trigger on your signal, feed a copy into
                <b> TR0</b> (analog, has a threshold) or <b>TRG-IN</b> (a NIM/TTL
                logic pulse).</p>
              <p className="muted">
                TR0: match the <b>edge</b> to your pulse (rising = positive-going),
                keep the <b>TR DC offset at midscale</b> (its threshold is only
                calibrated there), and set the <b>threshold</b> just above baseline
                noise. The threshold is in volts at the TR0 input: a 30 mV pulse
                is 30 mV here.
              </p>
            </div>
            <SettingsList
              defs={catalog.unit.filter((d) => LIVE_UNIT_KEYS.has(d.key))}
              geom={catalog.geometry}
              get={(k) => (config as any)[k]} onChange={updateBoard}
              locked={isLocked} onUnlock={unlockOne} />
            <p className="muted">
              Sampling, output format and the other campaign-tier settings
              live on the Experiment tab.
            </p>
          </Collapsible>
          <CalibrationPanel zc={zc}
            connected={connected} recording={recording}
            locked={isLocked("calibration")}
            onUnlock={() => unlockOne("calibration")}
            onStarted={() => setWipeEpoch((e) => e + 1)}
            onError={(title, lines) => push("err", title, lines)}
            onFinished={async (st) => {
              // The server steered the DACs underneath the UI: re-adopt what
              // the board holds now, exactly as after any other write.
              const cfg = await api.getConfig();
              setConfig(cfg); confirmed.current = cfg;
              const bad = st.report.filter((r) => r.status !== "ok");
              if (st.error) push("err", "Calibration failed", [st.error]);
              else if (st.message === "cancelled") {
                push("warn", "Calibration cancelled",
                     ["The board keeps the last completed pass."]);
              } else if (bad.length) {
                push("warn", "Calibration finished with findings",
                     bad.map((r) => `${r.channel}: ${r.status}`));
              } else {
                push("ok", `Calibration done - ${st.report.length} channels ok`);
              }
            }} />
          {status?.errors?.length ? (
            <div className="card errors">
              <h2>Errors</h2>
              {status.errors.slice(-6).map((e, i) => <div key={i} className="mono err">{e}</div>)}
            </div>
          ) : null}
          <RunsPanel status={status} refreshKey={runsKey} />
        </aside>
        ) : null}
        </fieldset>
      </div>
      <Toasts toasts={toasts} onDismiss={dismiss} />
      {recDialog ? (
        <div className="modal-backdrop" onClick={() => setRecDialog(false)}>
          <div className="modal rec-modal" onClick={(e) => e.stopPropagation()}
            role="dialog" aria-label="Run notes">
            <h3>
              Run {runNo.trim() || status?.next_run_number || "?"}
              {runName.trim() ? ` · ${runName.trim()}` : ""}
              {recMax.trim() ? ` · ${recMax.trim()} events` : ""}
            </h3>
            <p className={"rec-dest " + (intoExisting ? "into" : "")}>
              {intoExisting
                ? `Adds run_${runNo.trim() || status?.next_run_number}.root to the existing folder`
                : "Creates a new run folder"}
            </p>
            {/* Confirm-setup digest: the server's truth at this moment - the
                last look before these become this run's permanent record. */}
            <div className="rec-digest">
              <div className="rec-digest-row mono">
                {catalog.unit.find((d) => d.key === "drs4_frequency")
                  ?.choices?.find((c) => c.value === config.drs4_frequency)?.label
                  ?? config.drs4_frequency}
                {" · "}{config.output_format.toUpperCase()}
                {" · "}corr {config.correction_level}
                {" · "}post {config.post_trigger}%
                {" · "}TR thr {config.groups[0].fast_trigger_threshold}
                {" / off "}{config.groups[0].fast_trigger_dc_offset}
              </div>
              {recCond.filter((c) => c.key.trim()).length ? (
                <div className="rec-digest-cond">
                  {recCond.filter((c) => c.key.trim()).map((c, i) => (
                    <span className="cond-pill mono" key={i}>
                      {c.key} = {c.value}
                    </span>
                  ))}
                </div>
              ) : (
                <p className="muted">
                  No experiment conditions set - add beam energy, bias, and
                  friends on the Experiment tab; they snapshot into every run.
                </p>
              )}
            </div>
            <textarea autoFocus rows={4} maxLength={2000} value={recNote}
              placeholder="What is this run? Tested device, beam energy, HV, conditions..."
              onChange={(e) => setRecNote(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) startRec();
                if (e.key === "Escape") setRecDialog(false);
              }} />
            <p className="muted">
              Saved as "note" in run_metadata.json and shown in the run list.
              Ctrl+Enter records.
            </p>
            <div className="modal-btns">
              <button onClick={() => setRecDialog(false)}>Cancel</button>
              <button className="record" onClick={startRec}>
                <span className="rec-dot" />Record
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {tour ? <Tour steps={QUICK_USE} onClose={() => setTour(false)} /> : null}
    </div>
  );
}
