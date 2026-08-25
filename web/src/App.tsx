import { useCallback, useEffect, useRef, useState } from "react";
import { api, openTelemetry } from "./api";
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
  const [loadError, setLoadError] = useState<string | null>(null);
  const [runsKey, setRunsKey] = useState(0);   // bump to re-list runs
  const saveTimer = useRef<number | undefined>(undefined);
  // The config the unit last confirmed - what a change gets measured against.
  const confirmed = useRef<BoardConfig | null>(null);
  const { toasts, push, dismiss } = useToasts();

  const loadOnce = useCallback(async () => {
    setLoadError(null);
    try {
      const [cat, cfg, st] = await Promise.all([api.catalog(), api.getConfig(), api.status()]);
      setCatalog(cat); setConfig(cfg); setStatus(st);
      confirmed.current = cfg;
    } catch (e) {
      // Leaving this to console.error left the page reading "Loading..." for
      // ever, with nothing on screen to say the server had not answered.
      setLoadError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => { loadOnce(); }, [loadOnce]);

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

  const failed = (what: string) => (e: unknown) =>
    push("err", what, [e instanceof Error ? e.message : String(e)]);

  const start = async () => {
    try {
      const st = await api.start();
      setStatus(st);
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
      setStatus(await api.stop());
    } catch (e) {
      failed("Could not stop acquisition")(e);
    }
  };
  const startRec = async () => {
    try {
      const r = await api.recStart(runName, stampRun);
      setStatus(r.status);
      if (!r.ok) push("err", "Could not start recording", [r.error ?? "no reason given"]);
      else {
        push("ok", "Recording", [`${r.run}`]);
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
            onName={(ch, name) => updateChannel(ch, { name })} />
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
            onLoaded={({ config: cfg, notes, errors, restart, connected: up, running }) => {
              // Adopt what the unit reported even when it refused something:
              // that IS its state now, and showing the old values instead would
              // be the one thing this app must never do.
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
              if (restart.length && running) {
                const what = restart.join(", ");
                if (confirm(`${what} only take effect when the unit is re-armed.\n\nRestart acquisition now?`)) {
                  api.stop().then(() => api.start()).then(setStatus)
                    .catch(failed("Could not re-arm the unit"));
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
