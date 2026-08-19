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
    }).then(j<{ ok: boolean; config: BoardConfig }>),
  resetDefault: () => fetch("/api/config/default", { method: "POST" }).then(j<BoardConfig>),
  applyFanout: (source: number, scope: "all" | "bank") =>
    fetch("/api/config/apply", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source, scope }),
    }).then(j<BoardConfig>),
  start: () => fetch("/api/acq/start", { method: "POST" }).then(j<Status>),
  stop: () => fetch("/api/acq/stop", { method: "POST" }).then(j<Status>),
};

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
