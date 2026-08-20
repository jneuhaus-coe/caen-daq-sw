import { useEffect, useRef, useState } from "react";
import { api, openTelemetry } from "./api";
import type { BoardConfig, Catalog, Status, Telemetry } from "./types";
import { ChannelGrid } from "./components/ChannelGrid";
import { ChannelEditor } from "./components/ChannelEditor";
import { BankPanel } from "./components/BankPanel";
import { SettingsList } from "./components/SettingsList";
import { Collapsible } from "./components/Collapsible";
import { RateStrip } from "./components/RateStrip";
import { ConnectionBadge } from "./components/ConnectionBadge";
import { STATUS_POLL_MS } from "./types";

export function App() {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [config, setConfig] = useState<BoardConfig | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [tele, setTele] = useState<Telemetry | null>(null);
  const [selected, setSelected] = useState(0);
  const [serverUp, setServerUp] = useState(true);
  const [reconnecting, setReconnecting] = useState(false);
  const saveTimer = useRef<number | undefined>(undefined);

  useEffect(() => {
    (async () => {
      const [cat, cfg, st] = await Promise.all([api.catalog(), api.getConfig(), api.status()]);
      setCatalog(cat); setConfig(cfg); setStatus(st);
      const firstGroup = cfg.groups.findIndex((g) => g.enabled);
      setSelected(firstGroup < 0 ? 0 : firstGroup * cat.geometry.group_size);
    })().catch(console.error);
  }, []);

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
        .then((r) => { setConfig(r.config); if (r.errors?.length) setStatus((st) => st && { ...st, errors: [...st.errors, ...r.errors] }); })
        .catch(console.error);
    }, 250);
  };
  const updateBoard = (key: string, value: any) =>
    config && pushConfig({ ...config, [key]: value });
  const updateGroup = (g: number, key: string, value: any) => {
    if (!config) return;
    const groups = config.groups.map((gc, i) => (i === g ? { ...gc, [key]: value } : gc));
    pushConfig({ ...config, groups });
  };
  const updateChannelDc = (ch: number, value: number) => {
    if (!config) return;
    const channels = config.channels.map((c, i) => (i === ch ? { ...c, dc_offset: value } : c));
    pushConfig({ ...config, channels });
  };
  const fanout = async (scope: "bank" | "all") =>
    setConfig(await api.applyFanout(selected, scope));

  const start = async () => setStatus(await api.start());
  const stop = async () => setStatus(await api.stop());
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

  return (
    <div className="app">
      <header>
        <h1>DT5742B DAQ</h1>
        <ConnectionBadge status={status} serverUp={serverUp}
          busy={reconnecting} onReconnect={reconnect} />
        <span className={"pill" + (running ? " on" : "")}>{running ? "running" : "idle"}</span>
        <span className="pill mono">{tele?.events_seen ?? 0} events</span>
        <div className="spacer" />
        <button className="primary" onClick={start} disabled={running || !connected}
          title={connected ? "" : "No board connected"}>Start</button>
        <button onClick={stop} disabled={!running}>Stop</button>
      </header>

      <div className="body">
        <main>
          <div className="grid-head">
            <h2>Channels <span className="sub">all 16 · avg {config ? tele?.avg_window_s ?? 1 : 1}s window · click to inspect</span></h2>
            <div className="legend">
              <span className="lg live">live</span>
              <span className="lg dead">dead</span>
              <span className="lg clip">clip</span>
              <span className="lg off">bank off</span>
            </div>
          </div>
          <ChannelGrid catalog={catalog} config={config} tele={tele}
            selected={selected} onSelect={setSelected} />
        </main>

        <aside>
          <div className="card">
            <h2>Trigger rate</h2>
            <RateStrip tele={tele} />
          </div>
          <div className="card">
            <h2>Channel inspector</h2>
            <ChannelEditor catalog={catalog} config={config} selected={selected}
              tele={tele} onDcOffset={updateChannelDc} onFanout={fanout} />
          </div>
          <div className="card">
            <h2>Banks</h2>
            <BankPanel catalog={catalog} config={config} onGroupChange={updateGroup} />
          </div>
          <Collapsible title="Board settings">
            <SettingsList defs={catalog.board} get={(k) => (config as any)[k]} onChange={updateBoard} />
          </Collapsible>
          <Collapsible title="Config"
            right={<button className="mini" onClick={async () => setConfig(await api.resetDefault())}>Reset defaults</button>}>
            <p className="muted">Changes are written to the board and read back; the board holds the state.</p>
          </Collapsible>
          {status?.errors?.length ? (
            <div className="card errors">
              <h2>Errors</h2>
              {status.errors.slice(-6).map((e, i) => <div key={i} className="mono err">{e}</div>)}
            </div>
          ) : null}
        </aside>
      </div>
    </div>
  );
}
