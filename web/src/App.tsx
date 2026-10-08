import { useCallback, useEffect, useRef, useState } from "react";
import { api, openTelemetry } from "./api";
import type { Condition, DisplayPrefs, WaveMode } from "./api";
import { ConditionsPanel } from "./components/ConditionsPanel";
import { SessionsPanel } from "./components/SessionsPanel";
import { CalibrationPanel } from "./components/CalibrationPanel";
import type { AvgSettings, BoardConfig, Catalog, Status, Telemetry, ZeroCal } from "./types";
import { ChannelGrid } from "./components/ChannelGrid";
import { BankPanel } from "./components/BankPanel";
import { SettingsList } from "./components/SettingsList";
import { SettingControl } from "./components/SettingControl";
import { Collapsible } from "./components/Collapsible";
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
import { LockToggle } from "./components/LockToggle";
import { UpdateBanner } from "./components/UpdateBanner";
import { usePersistentState } from "./persist";
import { onFlush } from "./flush";
import { TR_OFF_MID_DAC, fmtDacVolts, trAbsThresholdV, trThresholdDacForAbs,
         zeroCodeAt, zeroLine } from "./volts";

// Settings that start out locked until someone unlocks them. The TR DC
// offset: the threshold is only defined at offset 0 (UM4270 sec 9.8.3), so a
// stray edit silently invalidates the trigger level.
const LOCKED_BY_DEFAULT = new Set(["fast_trigger_dc_offset"]);

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
  // Form values survive a reload - the one an update asks for included. The
  // remembered last-used values are "local" (every window); a window's own
  // drafts are "session" (that window only).
  const [runName, setRunName] = usePersistentState("runName", "");
  // Empty = let the server infer the next number from the data directory.
  const [runNo, setRunNo] = usePersistentState("runNo", "", "session");
  const [stampRun, setStampRun] = usePersistentState("stampRun", true);
  const [tour, setTour] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [runsKey, setRunsKey] = useState(0);   // bump to re-list runs
  // Per-channel waveform display ranges (volts). Persisted server-side so a
  // daq restart or a different browser comes back to the same view.
  const [yRanges, setYRanges] = useState<Record<number, [number, number]>>({});
  // Global channel controls: set the display window for all
  // 16 channels at once - handy when every channel sees a similar signal.
  const [allYMin, setAllYMin] = usePersistentState("allYMin", "");
  const [allYMax, setAllYMax] = usePersistentState("allYMax", "");
  // "avg": the 1 s rolling mean. "overlay": the last N single events piled
  // into a density picture. "scope": the newest single trace alone, fed by
  // free-running software triggers. Persisted with the display state.
  const [waveMode, setWaveMode] = useState<WaveMode>("avg");
  // Scope mode's software-trigger rate; committed via /api/scope.
  const [scopeHz, setScopeHz] = usePersistentState("scopeHz", "2");
  // The scope's channel-trigger: "" = show every event; a channel number =
  // only events where that trace crosses the level refresh the display.
  const [scopeTrigCh, setScopeTrigCh] = usePersistentState("scopeTrigCh", "");
  const [scopeTrigMv, setScopeTrigMv] = usePersistentState("scopeTrigMv", "20");
  const [scopeTrigEdge, setScopeTrigEdge] =
    usePersistentState<"rising" | "falling">("scopeTrigEdge", "falling");
  const [testN, setTestN] = usePersistentState("testN", "100");
  const [trigHelp, setTrigHelp] = useState(false);
  // Blank = record until stopped; a number = auto-close the run at N events.
  const [recMax, setRecMax] = usePersistentState("recMax", "");
  // The run-notes dialog: Record opens it, and the note it collects lands in
  // run_metadata.json - what was tested, beam energy, the context no
  // register readback can supply. Cleared after each run starts: a note
  // describes ONE run, and a stale one silently attached to the next run
  // would be worse than none.
  const [recDialog, setRecDialog] = useState(false);
  const [recNote, setRecNote] = usePersistentState("recNote", "", "session");
  // The conditions snapshot shown in the confirm-setup dialog, fetched fresh
  // each time it opens so it reflects the server's truth, not tab state.
  const [recCond, setRecCond] = useState<Condition[]>([]);
  // Live = watch and operate; Experiment = campaign setup, conditions, and
  // everything you would hate to change by accident mid-campaign.
  const [view, setView] = usePersistentState<"live" | "experiment">("view", "live");
  // Per-setting locks (house style: the icon left of the label). Keyed by
  // setting ("post_trigger"), bank setting ("bank1:enabled"), channel offset
  // ("ch:5") or activity ("calibration"); a key not present falls back to
  // LOCKED_BY_DEFAULT. Saved with the display prefs, so every window and a
  // reload see the same locks. A lock only stops edits from this UI - it
  // never writes or resets the value it protects.
  const [locks, setLocks] = useState<Record<string, boolean>>({});
  const locksRef = useRef(locks);
  locksRef.current = locks;
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
  // The writes those timers are holding, so a reload can send them now
  // instead of dropping an edit made in the last fraction of a second.
  const pendingConfig = useRef<(() => Promise<unknown>) | null>(null);
  const pendingDisplay = useRef<(() => Promise<unknown>) | null>(null);
  // The config the unit last confirmed - what a change gets measured against.
  const confirmed = useRef<BoardConfig | null>(null);
  // The server's config revision this tab is based on. Sent with every push
  // so a tab holding history is refused instead of silently reverting the
  // unit; when the status poll shows the revision moved (another window, a
  // session apply, a reconnect), the tab refetches rather than goes stale.
  const cfgRev = useRef(0);
  // The same for the display prefs (ranges, mode, locks), which every window
  // shares: another window's lock must show here, and must not be undone by
  // this window's next save of its own stale copy.
  const displayRev = useRef<number | null>(null);
  const { toasts, push, dismiss } = useToasts();
  // The sticky settings column sits just under the sticky header, whose
  // height depends on the width (the header is two rows, and may grow).
  const headerRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const el = headerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => document.documentElement.style
      .setProperty("--header-h", `${el.offsetHeight}px`));
    ro.observe(el);
    return () => ro.disconnect();
  }, [catalog !== null && config !== null]);

  const loadOnce = useCallback(async () => {
    setLoadError(null);
    try {
      const [cat, cfg, st] = await Promise.all([api.catalog(), api.getConfig(), api.status()]);
      setCatalog(cat); setConfig(cfg); setStatus(st);
      confirmed.current = cfg;
      cfgRev.current = st.config_rev ?? 0;
      displayRev.current = st.display_rev ?? null;
      // A scope already firing (from before a reload, or another window)
      // is the truth for its controls - not whatever was last typed here.
      if (st.scope_hz != null) {
        setScopeHz(String(st.scope_hz));
        const trig = st.scope_trigger;
        setScopeTrigCh(trig ? String(trig.channel) : "");
        if (trig) {
          setScopeTrigMv(String(trig.level_mv));
          setScopeTrigEdge(trig.edge === "rising" ? "rising" : "falling");
        }
      }
    } catch (e) {
      // Leaving this to console.error left the page reading "Loading..." for
      // ever, with nothing on screen to say the server had not answered.
      setLoadError(e instanceof Error ? e.message : String(e));
    }
    // Display prefs restore on their own - they never touch the hardware.
    // The display mode restores; the scope's trigger firing does NOT start
    // on page load - status.scope_hz says whether a scope is already live.
    api.getDisplay().then(adoptDisplay).catch(() => {});
  }, []);

  useEffect(() => { loadOnce(); }, [loadOnce]);

  // Keep the run-name dropdown in step with what is on disk; runsKey bumps
  // whenever a recording starts or stops.
  useEffect(() => {
    api.runs().then((r) => setRunDirs(r.runs.map((x) => x.id))).catch(() => {});
  }, [runsKey]);

  function adoptDisplay(d: DisplayPrefs) {
    setYRanges(fromPrefs(d));
    setWaveMode(asWaveMode(d.wave_mode));
    const l = asLocks(d.locks);
    locksRef.current = l;
    setLocks(l);
  }

  const asLocks = (v: unknown): Record<string, boolean> => {
    const out: Record<string, boolean> = {};
    if (v && typeof v === "object") {
      for (const [k, b] of Object.entries(v)) if (typeof b === "boolean") out[k] = b;
    }
    return out;
  };

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
                       mode: WaveMode, now = false) => {
    window.clearTimeout(displayTimer.current);
    const send = () => {
      pendingDisplay.current = null;
      const y_ranges: Record<string, [number, number]> = {};
      for (const [k, v] of Object.entries(ranges)) y_ranges[k] = v;
      return api.setDisplay({ y_ranges, wave_mode: mode,
                              locks: locksRef.current }).catch(() => {});
    };
    pendingDisplay.current = send;
    if (now) send();
    else displayTimer.current = window.setTimeout(send, 400);
  };

  const isLocked = (key: string) => locks[key] ?? LOCKED_BY_DEFAULT.has(key);
  const toggleLock = (key: string) => {
    const next = { ...locksRef.current, [key]: !isLocked(key) };
    locksRef.current = next;
    setLocks(next);
    // At once, not debounced: a lock is one deliberate click, and a window
    // closed (or reloaded) inside the debounce would silently drop it.
    saveDisplay(yRanges, waveMode, true);
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

  // The display average's window, as the server applies it (telemetry is
  // the truth; the fields show it, never a value this tab merely asked for).
  const avg: AvgSettings = tele?.avg
    ?? { mode: "time", seconds: tele?.avg_window_s ?? 1, events: 100 };
  // The mode just picked, until telemetry confirms it. Without it a number
  // typed straight after switching to "events" committed as SECONDS - the
  // field still followed the old mode for the telemetry round trip.
  const [avgModePick, setAvgModePick] = useState<AvgSettings["mode"] | null>(null);
  useEffect(() => {
    if (avgModePick && tele?.avg?.mode === avgModePick) setAvgModePick(null);
  }, [tele?.avg?.mode, avgModePick]);
  const avgMode = avgModePick ?? avg.mode;
  const avgLabel = avg.mode === "time" ? `${avg.seconds} s` : `${avg.events} events`;
  const applyAverage = (patch: Partial<AvgSettings>) => {
    api.setAverage(patch)
      .catch(failed("Could not change the average"));
  };
  // Clear: start the picture afresh. The average is computed on the server
  // (so this clears it for every window); the overlay's density pile lives
  // in this page, like the wipe on recording start.
  const clearWaves = () => {
    if (waveMode === "avg") {
      api.clearAverage().catch(failed("Could not clear the average"));
    } else {
      setWipeEpoch((e) => e + 1);
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

  // A dropped socket clears the telemetry: holding the last frame kept
  // showing "acquiring" from a server that could no longer say otherwise.
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
        // Display prefs changed elsewhere. Not while this window still has
        // an unsent edit of its own - that send comes back round as the next
        // revision anyway.
        if (st.display_rev != null && st.display_rev !== displayRev.current
            && !pendingDisplay.current) {
          displayRev.current = st.display_rev;
          const d = await api.getDisplay();
          if (!cancelled) adoptDisplay(d);
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

  // After an action that wrote the unit behind pushConfig's back (session,
  // file, reset, calibration): take up the server's revision now, rather
  // than have the next edit refused as stale until the poll catches up.
  const resync = () => { api.status().then(adoptStatus).catch(() => {}); };

  const pushConfig = (next: BoardConfig) => {
    setConfig(next);                       // optimistic, for input responsiveness
    window.clearTimeout(saveTimer.current);
    const send = () => {
      pendingConfig.current = null;
      // Whatever the board reports wins - a rejected write must not leave the
      // UI showing a value the hardware never took.
      return api.setConfig(next, cfgRev.current)
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
        .catch(() => {
          // Nothing confirmed this value: show what the unit last confirmed,
          // never the optimistic one.
          if (confirmed.current) setConfig(confirmed.current);
          push("err", "Could not reach the DAQ server", ["The setting was not applied."]);
        });
    };
    pendingConfig.current = send;
    saveTimer.current = window.setTimeout(send, 250);
  };
  useEffect(() => onFlush(() => {
    window.clearTimeout(saveTimer.current);
    window.clearTimeout(displayTimer.current);
    return Promise.all([pendingConfig.current?.(), pendingDisplay.current?.()]);
  }), []);
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
      await adoptStatus(await api.reconnect());
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
    // Re-list the runs on BOTH edges, whoever caused them: another window,
    // a bounded run closing itself, a lost unit cutting a run short.
    if (recordingNow !== prevRecording.current) setRunsKey((k) => k + 1);
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
  // With the server unreachable nothing here is known; say so rather than
  // repeat the last answer.
  const acqState = !serverUp ? "unknown"
    : recording ? "recording" : running ? "acquiring" : "idle";

  return (
    <div className="app">
      <header ref={headerRef}>
        {/* Row 1: where you are, what is attached, whether it is acquiring.
            Row 2: the Record cluster. Two rows so nothing wraps on a laptop -
            one row squeezed every label and button onto two lines. */}
        <div className="appbar">
          <h1>DT5742B DAQ{status?.version &&
            <span className="app-version">v{status.version}</span>}</h1>
          <nav className="view-tabs" role="tablist" aria-label="View">
            <button role="tab" aria-selected={view === "live"}
              className={view === "live" ? "on" : ""}
              onClick={() => setView("live")}>Live</button>
            <button role="tab" aria-selected={view === "experiment"}
              className={view === "experiment" ? "on" : ""}
              title="Campaign setup: the settings and experiment facts that stay fixed for a whole campaign"
              onClick={() => setView("experiment")}>Experiment Settings</button>
          </nav>
          <div className="spacer" />
          <ConnectionBadge status={status} serverUp={serverUp}
            busy={reconnecting} onReconnect={reconnect} />
          {/* Acquisition lives beside the connection state, away from the
              Record row: enabling it watches, and only Record writes -
              keeping the two apart is what stops "for N ev" reading as an
              acquisition option. */}
          <div className="acq-group">
            <span className={"acq-state " + acqState}
              title="Acquisition state, and events read out since it was enabled">
              <span className="pill state">{acqState}</span>
              <span className="acq-count mono">
                {(tele?.events_seen ?? status?.events_seen ?? 0).toLocaleString()} ev
              </span>
            </span>
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
          <button className="help-btn" onClick={() => setTour(true)}
            title="Quick use" aria-label="Quick use">?</button>
        </div>
        <div className="run-controls">
          <div className={"rec-group" + (recording ? " on" : "")}>
            {recording ? (
              <>
                <span className="rec-dot" />
                <span className="rec-label">Recording</span>
                <span className="rec-name mono">{tele?.run_id ?? status?.run_id}</span>
                <span className="rec-count mono">
                  <Elapsed since={tele?.run_started ?? status?.run_started ?? null} />
                  {" · "}{(tele?.recorded ?? status?.recorded ?? 0).toLocaleString()} ev
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
                  Stop after
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
                    locked={isLocked} onToggleLock={toggleLock} />
                </div>
                <Collapsible title="Bank Settings" defaultOpen>
                  <BankPanel catalog={catalog} config={config}
                    onGroupChange={updateGroup} />
                </Collapsible>
              </div>
              <div className="exp-col">
                <ConditionsPanel onError={(t, l) => push("err", t, l)} />
                <SessionsPanel
                  recording={recording}
                  onSaved={(name) => push("ok", `Session "${name}" saved`)}
                  onImported={(name, kind, notes) => push(notes.length ? "warn" : "ok",
                    `Imported as session "${name}"`,
                    [kind === "config"
                      ? "Board settings only - Apply leaves the display and conditions alone."
                      : "Nothing is sent to the unit until you Apply it.", ...notes])}
                  onError={(title, lines) => push("err", title, lines)}
                  onApplied={(cfg, display, errors, isConn, name) => {
                    setConfig(cfg); confirmed.current = cfg;
                    resync();
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
              </div>
            </div>
          </main>
        ) : (
        <main>
          <div className="grid-head">
            <h2 title="Click a channel's title to rename it">Channels <span className="sub">
              {waveMode === "avg"
                ? `average of the last ${avgLabel}`
                : waveMode === "scope"
                ? "newest single trace, full resolution"
                : `last ${PERSIST_TRACES} events, density-shaded`}
            </span></h2>
            <div className="wave-mode" role="group" aria-label="Waveform display mode">
              <button className={waveMode === "avg" ? "on" : ""}
                title={`Rolling mean of the last ${avgLabel}`}
                onClick={() => changeWaveMode("avg")}>Avg</button>
              <button className={waveMode === "overlay" ? "on" : ""}
                title={`The last ${PERSIST_TRACES} single events stacked, brightness = how often a path is taken`}
                onClick={() => changeWaveMode("overlay")}>Overlay</button>
              <button className={waveMode === "scope" ? "on" : ""}
                disabled={!connected}
                title="One full-resolution trace at a time, fed by free-running software triggers - for studying the noise on a line"
                onClick={() => changeWaveMode("scope")}>Scope</button>
              {waveMode === "avg" ? (
                <span className="avg-ctl"
                  title={"Average over a time span (follows the beam: empties when triggers stop) or over a number of events (holds the last N when triggers stop). Display only - nothing recorded is averaged."}>
                  over last
                  <BlurInput type="number" className="avg-n" selectOnFocus
                    min={avgMode === "time" ? 0.1 : 1}
                    step={avgMode === "time" ? 0.1 : 1}
                    value={avgMode === "time" ? avg.seconds : avg.events}
                    onCommit={(v) => {
                      const n = Number(v);
                      if (!Number.isFinite(n) || n <= 0) return;
                      applyAverage(avgMode === "time" ? { mode: "time", seconds: n }
                                                      : { mode: "events", events: Math.round(n) });
                    }} />
                  <select value={avgMode}
                    onChange={(e) => {
                      const mode = e.target.value as AvgSettings["mode"];
                      setAvgModePick(mode);
                      applyAverage({ mode });
                    }}>
                    <option value="time">s</option>
                    <option value="events">events</option>
                  </select>
                </span>
              ) : null}
              {waveMode !== "scope" ? (
                <span className="wave-clear">
                  <button onClick={clearWaves}
                    title={waveMode === "avg"
                      ? "Empty the average and start it afresh from the next event (every window sees it)"
                      : "Wipe the overlay and start piling up events afresh"}>
                    Clear
                  </button>
                </span>
              ) : null}
              {waveMode === "scope" ? (
                <>
                  {/* The server is the truth about whether the scope fires:
                      after a restart, a lost unit or a trigger error the mode
                      is still shown but nothing is firing - say so. */}
                  {status && status.scope_hz == null ? (
                    <span className="scope-idle"
                      title="Scope mode is selected but its software triggers are not firing (the server restarted, the unit was lost, or a trigger failed).">
                      ⚠ not firing
                      <button disabled={!connected}
                        onClick={() => applyScope(scopeHz, scopeTrigCh, scopeTrigMv, scopeTrigEdge)}>
                        start
                      </button>
                    </span>
                  ) : null}
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
            clearEpoch={wipeEpoch} />
        </main>
        )}

        {view === "live" ? (
        <aside>
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
          {(() => {
            // TR0: the digitized trace (when TR digitizing is on - the same
            // signal both groups see, shown once: group 0's copy, else 1's)
            // with its two settings underneath. The trace is in TR0 input
            // volts; the trigger line is drawn ONLY at offset 0x8000, the one
            // case UM4270 sec 9.8.3 gives the threshold in volts for.
            const trCh = tele?.channels["16"] ? 16 : tele?.channels["17"] ? 17 : null;
            const tr = config.fast_trigger_digitizing && trCh != null
              ? tele!.channels[String(trCh)] : null;
            const [g0, g1] = config.groups;
            const gr = trCh != null ? trCh - 16 : 0;
            const off = config.groups[gr].fast_trigger_dc_offset;
            const trLine = zeroLine(16 + gr, catalog.geometry, zc);
            const thr = config.groups[gr].fast_trigger_threshold;
            const markers = off === TR_OFF_MID_DAC
              ? [{ v: trAbsThresholdV(thr), label: "trigger", color: "#f85149" }]
              : [];
            const diverged = ["fast_trigger_threshold", "fast_trigger_dc_offset"]
              .some((k) => (g0 as any)[k] !== (g1 as any)[k]);
            const offMid = g0.fast_trigger_dc_offset === TR_OFF_MID_DAC;
            // The TR offset field stays on CAEN's scale (Tab. 9.1), never the
            // 0 V calibration: 0 is midscale 0x8000, where the threshold is
            // defined.
            const offDef = catalog.bank.find((d) => d.key === "fast_trigger_dc_offset")!;
            const offLocked = isLocked("fast_trigger_dc_offset");
            return (
              <div className="card">
                <h2>TR0 <span className="sub">fast trigger</span></h2>
                {tr ? (
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
                ) : (
                  <p className="muted tr-off">
                    {config.fast_trigger_digitizing
                      ? "Waiting for events."
                      : "TR0 is not being digitized (Digitize TR traces, below)."}
                  </p>
                )}
                <div className="settings-grid tr0-settings">
                  {/* Not lockable - tuned while watching - but in line with
                      the TR DC offset's label below. */}
                  <div className="setting-row lockable"
                    title={"Trigger level in volts at the TR0 input, relative to its ground (shield), per CAEN's worked examples (UM4270 sec 9.8.3): with the TR DC offset at 0x8000, DAC 0x6666 = 0 V and 13.2 DAC steps per mV - a NIM signal (0 to -800 mV) triggers at half swing with 0x51C6 = -400 mV. CAEN gives no formula at other offsets - keep the offset at 0.\n\nOne DAC step is 0.0758 mV; the field shows as many digits as it takes to name the exact register word.\n\nDAC word: " + g0.fast_trigger_threshold + "\n\nCAEN_DGTZ_SetGroupFastTriggerThreshold"}>
                    <span className="lock-spacer" />
                    <label>
                      TR threshold
                      {!offMid ? (
                        <span className="muted tr-rel-note" title="The threshold is only defined in volts with the TR DC offset at 0 (midscale 0x8000) - UM4270 sec 9.8.3.">
                          ⚠ offset not 0
                        </span>
                      ) : null}
                    </label>
                    <span className="field">
                      {/* min sets the arrow keys' step base, so it must sit on
                          the step grid: -1.986 made them walk -0.001, 0.004,
                          0.009... DAC 0..65535 spans -1.9859..+2.9789 V. */}
                      <BlurInput type="number" step={0.001} min={-1.985} max={2.978}
                        selectOnFocus
                        value={fmtDacVolts(g0.fast_trigger_threshold,
                                           trAbsThresholdV, trThresholdDacForAbs)}
                        onCommit={(v) => {
                          updateTrBoth("fast_trigger_threshold",
                            trThresholdDacForAbs(Number(v) || 0));
                        }} />
                      <span className="unit">V</span>
                    </span>
                  </div>
                  <div className={"setting-row lockable" + (offLocked ? " locked" : "")}
                    title={[offDef.help, offDef.caen].filter(Boolean).join("\n\n")}>
                    <LockToggle locked={offLocked} what="TR DC offset"
                      onToggle={() => toggleLock("fast_trigger_dc_offset")} />
                    <label>TR DC offset</label>
                    <SettingControl def={offDef} value={g0.fast_trigger_dc_offset}
                      geom={catalog.geometry} disabled={offLocked}
                      onChange={(v) => updateTrBoth("fast_trigger_dc_offset", v)} />
                  </div>
                </div>
                {diverged ? (
                  <div className="tr-diverged">
                    The two banks' TR0 registers differ. Editing here writes
                    both;{" "}
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
              </div>
            );
          })()}
          <Collapsible title="Trigger Settings" defaultOpen>
            {(() => {
              // Explicit order and labels: timing first, then the trigger
              // sources, each source's own option right under it and only
              // while that source is enabled.
              const def = (k: string) => catalog.unit.find((d) => d.key === k)!;
              const row = (k: string, label: string) => {
                const d = def(k);
                return (
                  <div className="setting-row" key={k}
                    title={[d.help, d.caen].filter(Boolean).join("\n\n")}>
                    <label>{label}</label>
                    <SettingControl def={d} value={(config as any)[k]} geom={catalog.geometry}
                      dependsOn={d.depends_on ? (config as any)[d.depends_on] : undefined}
                      onChange={(v) => updateBoard(k, v)} />
                  </div>
                );
              };
              return (
                <>
                  <button className="trig-help-btn" onClick={() => setTrigHelp(true)}>
                    How triggers work
                  </button>
                  <div className="settings-grid">
                    {row("post_trigger", "Post-trigger duration")}
                    {row("trigger_edge", "Trigger edge")}
                    <div className="settings-divider">Trigger Sources</div>
                    {row("external_trigger", "TRG-IN")}
                    {config.external_trigger !== "disabled" ? row("io_level", "TRG-IN level") : null}
                    {row("fast_trigger", "TR0")}
                    {config.fast_trigger !== "disabled"
                      ? row("fast_trigger_digitizing", "Digitize TR traces") : null}
                    {row("software_trigger", "Software trigger")}
                  </div>
                </>
              );
            })()}
          </Collapsible>
          {trigHelp ? (
            <div className="modal-backdrop" onClick={() => setTrigHelp(false)}>
              <div className="modal trig-modal" role="dialog" aria-label="How triggers work"
                onClick={(e) => e.stopPropagation()}>
                <h3>How triggers work</h3>
                <p>
                  The board takes an event when <b>any</b> enabled source fires.
                </p>
                <p>
                  The 16 signal channels <b>cannot</b> trigger. To trigger on a
                  signal, send a copy of it to <b>TR0</b> (analog, with a
                  threshold) or a logic pulse to <b>TRG-IN</b> (NIM or TTL).
                </p>
                <p>For TR0:</p>
                <ul>
                  <li>Set the <b>edge</b> to match the pulse: rising for
                    positive-going.</li>
                  <li>Keep the <b>TR DC offset at 0</b>. The threshold is only
                    defined there.</li>
                  <li>Set the <b>threshold</b> in volts at the TR0 input, just
                    clear of the baseline noise.</li>
                </ul>
                <div className="modal-btns">
                  <button className="primary" onClick={() => setTrigHelp(false)}>OK</button>
                </div>
              </div>
            </div>
          ) : null}
          <CalibrationPanel zc={zc} active={!!status?.calibrating}
            connected={connected} recording={recording}
            onStarted={() => setWipeEpoch((e) => e + 1)}
            onError={(title, lines) => push("err", title, lines)}
            onFinished={async (st) => {
              // The server steered the DACs underneath the UI: re-adopt what
              // the board holds now, exactly as after any other write.
              const cfg = await api.getConfig();
              setConfig(cfg); confirmed.current = cfg;
              resync();
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
      <UpdateBanner status={status} recording={recording} />
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
