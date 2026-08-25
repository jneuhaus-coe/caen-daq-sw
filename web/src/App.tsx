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
import { ConnectionBadge } from "./components/ConnectionBadge";
import { STATUS_POLL_MS } from "./types";

export function App() {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [config, setConfig] = useState<BoardConfig | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [tele, setTele] = useState<Telemetry | null>(null);
  const [serverUp, setServerUp] = useState(true);
  const [reconnecting, setReconnecting] = useState(false);
  const [runName, setRunName] = useState("");
  const [stampRun, setStampRun] = useState(true);
  const [tour, setTour] = useState(false);
  const [runsKey, setRunsKey] = useState(0);   // bump to re-list runs
  // Per-channel waveform display ranges (volts). Persisted server-side so a
  // daq restart or a different browser comes back to the same view.
  const [yRanges, setYRanges] = useState<Record<number, [number, number]>>({});
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
    api.getDisplay().then((d) => setYRanges(fromPrefs(d))).catch(() => {});
  }, []);

  const fromPrefs = (d: DisplayPrefs): Record<number, [number, number]> => {
    const out: Record<number, [number, number]> = {};
    for (const [k, v] of Object.entries(d.y_ranges ?? {})) {
      if (Array.isArray(v) && v.length === 2 && v[0] < v[1]) out[Number(k)] = [v[0], v[1]];
    }
    return out;
  };

  const applyYRanges = (next: Record<number, [number, number]>) => {
    setYRanges(next);
    window.clearTimeout(displayTimer.current);
    displayTimer.current = window.setTimeout(() => {
      const y_ranges: Record<string, [number, number]> = {};
      for (const [k, v] of Object.entries(next)) y_ranges[k] = v;
      api.setDisplay({ y_ranges }).catch(() => {});
    }, 400);
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
  const startRec = async () => {
    const r = await api.recStart(runName, stampRun);
    setStatus(r.status);
    if (!r.ok) push("err", "Could not start recording", [r.error ?? ""]);
    else {
      push("ok", "Recording", [`${r.run}`]);
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
            <h2>Channels <span className="sub">all 16 · avg {tele?.avg_window_s ?? 1}s window · click a title to rename</span></h2>
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
            yRanges={yRanges} onYRange={changeYRange} />
        </main>

        <aside>
          <div className="card">
            <h2>Trigger rate</h2>
            <RateStrip tele={tele} />
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
