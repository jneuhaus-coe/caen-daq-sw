import type { BoardConfig, Catalog, Status, Telemetry } from "./types";

async function j<T>(r: Response): Promise<T> {
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return r.json();
}

export const api = {
  status: () => fetch("/api/status").then(j<Status>),
  catalog: () => fetch("/api/catalog").then(j<Catalog>),
  getConfig: () => fetch("/api/config").then(j<BoardConfig>),
  setConfig: (cfg: BoardConfig) =>
    fetch("/api/config", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(cfg),
    }).then(j<{ ok: boolean; config: BoardConfig; errors: string[]; connected: boolean }>),
  resetDefault: () => fetch("/api/config/default", { method: "POST" }).then(j<BoardConfig>),
  reconnect: () => fetch("/api/board/reconnect", { method: "POST" }).then(j<Status>),
  start: () => fetch("/api/acq/start", { method: "POST" }).then(j<Status>),
  recStart: (name: string, timestamp: boolean, runNumber?: number | null) =>
    fetch("/api/rec/start", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, timestamp, run_number: runNumber ?? null }),
    }).then(j<{ ok: boolean; error?: string; run?: string; status: Status }>),
  recStop: () =>
    fetch("/api/rec/stop", { method: "POST" })
      .then(j<{ ok: boolean; error?: string; run?: string; status: Status }>),
  stop: () => fetch("/api/acq/stop", { method: "POST" }).then(j<Status>),

  getDisplay: () => fetch("/api/display").then(j<DisplayPrefs>),
  setDisplay: (d: DisplayPrefs) =>
    fetch("/api/display", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(d),
    }).then(j<{ ok: boolean }>),
  listSessions: () =>
    fetch("/api/sessions").then(j<{ sessions: SessionInfo[] }>),
  saveSession: (name: string) =>
    fetch(`/api/sessions/${encodeURIComponent(name)}`, { method: "POST" })
      .then(j<{ ok: boolean; name: string; saved_at: number }>),
  applySession: (name: string) =>
    fetch(`/api/sessions/${encodeURIComponent(name)}/apply`, { method: "POST" })
      .then(j<{ ok: boolean; config: BoardConfig; display: DisplayPrefs;
                errors: string[]; connected: boolean }>),
  deleteSession: (name: string) =>
    fetch(`/api/sessions/${encodeURIComponent(name)}`, { method: "DELETE" })
      .then(j<{ ok: boolean }>),
};

export interface SessionInfo { name: string; saved_at: number | null; }

/** UI state that persists across restarts, keyed however the UI likes.
 *  y_ranges: per-channel waveform display range in volts, [min, max].
 *  wave_mode: "avg" (rolling average) or "overlay" (persistence density). */
export interface DisplayPrefs {
  y_ranges?: Record<string, [number, number]>;
  wave_mode?: "avg" | "overlay";
}

/** Subscribe to telemetry; auto-reconnects. Returns an unsubscribe fn. */
export function openTelemetry(onData: (t: Telemetry) => void): () => void {
  let ws: WebSocket | null = null;
  let closed = false;
  const connect = () => {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(`${proto}://${location.host}/ws/telemetry`);
    ws.onmessage = (e) => onData(JSON.parse(e.data));
    ws.onclose = () => { if (!closed) setTimeout(connect, 1000); };
    ws.onerror = () => ws?.close();
  };
  connect();
  return () => { closed = true; ws?.close(); };
}
