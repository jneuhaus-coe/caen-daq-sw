import { useEffect, useRef, useState } from "react";
import { api, openTelemetry } from "./api";
import type { BoardConfig, Catalog, Status, Telemetry } from "./types";
import { ChannelGrid } from "./components/ChannelGrid";
import { ChannelEditor } from "./components/ChannelEditor";
import { BankPanel } from "./components/BankPanel";
import { SettingsList } from "./components/SettingsList";
import { Collapsible } from "./components/Collapsible";
import { RateStrip } from "./components/RateStrip";

export function App() {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [config, setConfig] = useState<BoardConfig | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [tele, setTele] = useState<Telemetry | null>(null);
  const [selected, setSelected] = useState(0);
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

  const pushConfig = (next: BoardConfig) => {
    setConfig(next);
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => api.setConfig(next).catch(console.error), 250);
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

  if (!catalog || !config) return <div className="loading">Loading…</div>;
  const running = tele?.running ?? status?.running ?? false;

  return (
    <div className="app">
      <header>
        <h1>DT5742B DAQ</h1>
        <span className="pill">{status?.board.model ?? "board"}</span>
        <span className={"pill" + (running ? " on" : "")}>{running ? "running" : "idle"}</span>
        <span className="pill mono">{tele?.events_seen ?? 0} events</span>
        <div className="spacer" />
        <button className="primary" onClick={start} disabled={running}>Start</button>
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
            <p className="muted">Changes autosave and persist as last-used.</p>
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
