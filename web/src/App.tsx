import { useEffect, useRef, useState } from "react";
import { api, openTelemetry } from "./api";
import type { DisplayPrefs } from "./api";
import { SessionsPanel } from "./components/SessionsPanel";
import type { BoardConfig, Catalog, Status, Telemetry } from "./types";
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

export function App() {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [config, setConfig] = useState<BoardConfig | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [tele, setTele] = useState<Telemetry | null>(null);
  const [serverUp, setServerUp] = useState(true);
  const [reconnecting, setReconnecting] = useState(false);
  const [runName, setRunName] = useState("");
  // Empty = let the server infer the next number from the data directory.
  const [runNo, setRunNo] = useState("");
  const [stampRun, setStampRun] = useState(true);
  const [tour, setTour] = useState(false);
  const [runsKey, setRunsKey] = useState(0);   // bump to re-list runs
  // Per-channel waveform display ranges (volts). Persisted server-side so a
  // daq restart or a different browser comes back to the same view.
  const [yRanges, setYRanges] = useState<Record<number, [number, number]>>({});
  // "avg": the 1 s rolling mean. "overlay": the last N single events piled
  // into a density picture. Persisted with the rest of the display state.
  const [waveMode, setWaveMode] = useState<"avg" | "overlay">("avg");
  const [testN, setTestN] = useState("100");
  // Blank = record until stopped; a number = auto-close the run at N events.
  const [recMax, setRecMax] = useState("");
  const saveTimer = useRef<number | undefined>(undefined);
  const displayTimer = useRef<number | undefined>(undefined);
  // The config the unit last confirmed - what a change gets measured against.
  const confirmed = useRef<BoardConfig | null>(null);
  const { toasts, push, dismiss } = useToasts();

  useEffect(() => {
    (async () => {
      const [cat, cfg, st] = await Promise.all([api.catalog(), api.getConfig(), api.status()]);
      setCatalog(cat); setConfig(cfg); setStatus(st);
      confirmed.current = cfg;
    })().catch(console.error);
    // Display prefs restore on their own - they never touch the hardware.
    api.getDisplay().then((d) => {
      setYRanges(fromPrefs(d));
      setWaveMode(d.wave_mode === "overlay" ? "overlay" : "avg");
    }).catch(() => {});
  }, []);

  const fromPrefs = (d: DisplayPrefs): Record<number, [number, number]> => {
    const out: Record<number, [number, number]> = {};
    for (const [k, v] of Object.entries(d.y_ranges ?? {})) {
      if (Array.isArray(v) && v.length === 2 && v[0] < v[1]) out[Number(k)] = [v[0], v[1]];
    }
    return out;
  };

  const saveDisplay = (ranges: Record<number, [number, number]>,
                       mode: "avg" | "overlay") => {
    window.clearTimeout(displayTimer.current);
    displayTimer.current = window.setTimeout(() => {
      const y_ranges: Record<string, [number, number]> = {};
      for (const [k, v] of Object.entries(ranges)) y_ranges[k] = v;
      api.setDisplay({ y_ranges, wave_mode: mode }).catch(() => {});
    }, 400);
  };

  const applyYRanges = (next: Record<number, [number, number]>) => {
    setYRanges(next);
    saveDisplay(next, waveMode);
  };

  const changeWaveMode = (mode: "avg" | "overlay") => {
    setWaveMode(mode);
    saveDisplay(yRanges, mode);
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
        if (!cancelled) { setStatus(st); setServerUp(true); }
      } catch {
        if (!cancelled) setServerUp(false);
      }
    };
    tick();
    const id = window.setInterval(tick, STATUS_POLL_MS);
    return () => { cancelled = true; window.clearInterval(id); };
  }, []);

  const pushConfig = (next: BoardConfig) => {
    setConfig(next);                       // optimistic, for input responsiveness
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      // Whatever the board reports wins - a rejected write must not leave the
      // UI showing a value the hardware never took.
      api.setConfig(next)
        .then((r) => {
          setConfig(r.config);
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
  const updateChannel = (ch: number, patch: Partial<BoardConfig["channels"][number]>) => {
    if (!config) return;
    const channels = config.channels.map((c, i) => (i === ch ? { ...c, ...patch } : c));
    pushConfig({ ...config, channels });
  };

  const start = async () => setStatus(await api.start());
  const stop = async () => setStatus(await api.stop());
  const fireTest = async () => {
    // The bench source: the 742 has no channel self-trigger, so with nothing
    // on TRG-IN/TR0 this is how events happen. Starts acquisition on its own.
    const n = Math.max(1, Math.round(Number(testN) || 100));
    const r = await api.trigger(n, 10);
    setStatus(r.status);
    if (!r.ok) push("err", "Could not fire test triggers", [r.error ?? ""]);
    else push("ok", `Firing ${r.queued} test triggers at 10 Hz`);
  };
  const startRec = async () => {
    const n = runNo.trim() === "" ? null : Number(runNo);
    const m = recMax.trim() === "" ? null : Number(recMax);
    const r = await api.recStart(runName, stampRun,
                                 Number.isFinite(n as number) ? n : null,
                                 Number.isFinite(m as number) ? m : null);
    setStatus(r.status);
    if (!r.ok) push("err", "Could not start recording", [r.error ?? ""]);
    else {
      push("ok", "Recording", [`${r.run}`]);
      setRunNo("");            // the next number is inferred again
      setRunsKey((k) => k + 1);
    }
  };
  const stopRec = async () => {
    const r = await api.recStop();
    setStatus(r.status);
    if (r.ok) push("ok", "Recording stopped", [`${r.run}`]);
    setRunsKey((k) => k + 1);
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

  if (!catalog || !config) return <div className="loading">Loading…</div>;
  const running = tele?.running ?? status?.running ?? false;
  const connected = serverUp && !!status?.opened;
  const recording = tele?.recording ?? status?.recording ?? false;
  const acqState = recording ? "recording" : running ? "acquiring" : "idle";

  return (
    <div className="app">
      <header>
        <h1>DT5742B DAQ</h1>
        <ConnectionBadge status={status} serverUp={serverUp}
          busy={reconnecting} onReconnect={reconnect} />
        <span className={"pill state " + acqState}>{acqState}</span>
        <span className="pill mono">{tele?.events_seen ?? 0} events</span>
        <div className="spacer" />
        <div className="run-controls">
          <div className="acq-group">
            {!running ? (
              <button className="primary" onClick={start} disabled={!connected}
                title={connected ? "Watch live — nothing is written to disk"
                                 : "No unit connected"}>
                Start Acquisition
              </button>
            ) : null}
            {/* Hidden while recording: stopping acquisition there would end the
                run, and "Stop recording" is the button you actually want. */}
            {running && !recording ? (
              <button onClick={stop}>Stop Acquisition</button>
            ) : null}
          </div>
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
                  disabled={!connected}
                  onChange={(e) => setRunName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") startRec(); }} />
                <label className="rec-label" htmlFor="runno"
                  title="The analysis-facing run number (run_N.root). Prefilled with one past the highest number in the data directory; type to override.">
                  Run #
                </label>
                <input id="runno" className="rec-input rec-no" type="number" min={1}
                  placeholder={String(status?.next_run_number ?? "")}
                  value={runNo} disabled={!connected}
                  onChange={(e) => setRunNo(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") startRec(); }} />
                <label className="rec-label" htmlFor="recmax"
                  title="Stop the recording automatically after this many events. Blank = record until stopped. Acquisition keeps running either way.">
                  for
                </label>
                <input id="recmax" className="rec-input rec-no" type="number" min={1}
                  placeholder="&#8734; ev" value={recMax} disabled={!connected}
                  onChange={(e) => setRecMax(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") startRec(); }} />
                <label className="rec-stamp" title="Append the date and time, so runs of the same name never collide">
                  <input type="checkbox" checked={stampRun} disabled={!connected}
                    onChange={(e) => setStampRun(e.target.checked)} />
                  Include timestamp
                </label>
                <button className="record" onClick={startRec} disabled={!connected}
                  title="Start writing this run to disk">
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
        <main>
          <div className="grid-head">
            <h2>Channels <span className="sub">
              {waveMode === "avg"
                ? `all 16 · avg ${tele?.avg_window_s ?? 1}s window · click a title to rename`
                : `all 16 · last ${PERSIST_TRACES} events, density-shaded · click a title to rename`}
            </span></h2>
            <div className="wave-mode" role="group" aria-label="Waveform display mode">
              <button className={waveMode === "avg" ? "on" : ""}
                title={`Rolling mean of the last ${tele?.avg_window_s ?? 1}s of events`}
                onClick={() => changeWaveMode("avg")}>Avg</button>
              <button className={waveMode === "overlay" ? "on" : ""}
                title={`The last ${PERSIST_TRACES} single events stacked, brightness = how often a path is taken`}
                onClick={() => changeWaveMode("overlay")}>Overlay</button>
            </div>
            <div className="legend">
              <span className="lg live">live</span>
              <span className="lg dead">dead</span>
              <span className="lg clip">clip</span>
              <span className="lg off">bank off</span>
            </div>
          </div>
          <ChannelGrid catalog={catalog} config={config} tele={tele}
            onDcOffset={(ch, dac) => updateChannel(ch, { dc_offset: dac })}
            onName={(ch, name) => updateChannel(ch, { name })}
            yRanges={yRanges} onYRange={changeYRange} waveMode={waveMode} />
        </main>

        <aside>
          {(() => {
            // The digitized TR0 trace, when TR digitizing is on: the same
            // signal both groups see, shown once (group 0's copy, else 1's).
            const trCh = tele?.channels["16"] ? 16 : tele?.channels["17"] ? 17 : null;
            const tr = trCh != null ? tele!.channels[String(trCh)] : null;
            if (!config.fast_trigger_digitizing || !tr) return null;
            return (
              <div className="card">
                <h2>TR0 <span className="sub">fast trigger · approx scale</span></h2>
                <MiniWave wave={tr.wave} dcOffset={config.groups[trCh! - 16].fast_trigger_dc_offset}
                  geom={catalog.geometry}
                  windowNs={tele ? tele.sample_period_ns * tele.record_length : undefined}
                  postTriggerPct={config.post_trigger}
                  color="#e3b341" height={110}
                  yRange={yRanges[trCh!]}
                  onYRange={(range, all) => changeYRange(trCh!, range, all)}
                  mode={waveMode} lastWave={tr.last} lastId={tr.last_index} />
              </div>
            );
          })()}
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
          <Collapsible title="Unit Settings" defaultOpen>
            <SettingsList defs={catalog.unit} geom={catalog.geometry}
              get={(k) => (config as any)[k]} onChange={updateBoard} />
          </Collapsible>
          <Collapsible title="Bank Settings" defaultOpen>
            <BankPanel catalog={catalog} config={config} onGroupChange={updateGroup} />
          </Collapsible>
          <SessionsPanel
            recording={recording}
            onSaved={(name) => push("ok", `Session "${name}" saved`)}
            onError={(title, lines) => push("err", title, lines)}
            onApplied={(cfg, display, errors, connected, name) => {
              setConfig(cfg); confirmed.current = cfg;
              setYRanges(fromPrefs(display));
              setWaveMode(display.wave_mode === "overlay" ? "overlay" : "avg");
              if (!connected) {
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
              const cfg = await api.resetDefault();
              setConfig(cfg); confirmed.current = cfg;
              push("ok", "Defaults applied and read back from unit");
            }}
            onLoaded={(cfg, notes, restart, running) => {
              setConfig(cfg); confirmed.current = cfg;
              push(notes.length ? "warn" : "ok",
                   "Config loaded and read back from unit", notes);
              if (restart.length && running) {
                const what = restart.join(", ");
                if (confirm(`${what} only take effect when the unit is re-armed.\n\nRestart acquisition now?`)) {
                  api.stop().then(() => api.start()).then(setStatus).catch(console.error);
                }
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
        </fieldset>
      </div>
      <Toasts toasts={toasts} onDismiss={dismiss} />
      {tour ? <Tour steps={QUICK_USE} onClose={() => setTour(false)} /> : null}
    </div>
  );
}
