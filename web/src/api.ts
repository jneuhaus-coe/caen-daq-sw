import type { BoardConfig, Catalog, Status, Telemetry } from "./types";

async function j<T>(r: Response): Promise<T> {
  if (!r.ok) {
    // FastAPI puts the reason in `detail`; "500 Internal Server Error" on its
    // own tells the operator nothing they can act on.
    let detail = "";
    try {
      detail = (await r.json())?.detail ?? "";
    } catch { /* not JSON - the status line is all there is */ }
    throw new Error(detail || `${r.status} ${r.statusText}`);
  }
  return r.json();
}

export interface ConfigResult {
  ok: boolean;
  config: BoardConfig;
  errors: string[];
  connected: boolean;
}

export const api = {
  status: () => fetch("/api/status").then(j<Status>),
  catalog: () => fetch("/api/catalog").then(j<Catalog>),
  getConfig: () => fetch("/api/config").then(j<BoardConfig>),
  setConfig: (cfg: BoardConfig) =>
    fetch("/api/config", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(cfg),
    }).then(j<ConfigResult>),
  resetDefault: () =>
    fetch("/api/config/default", { method: "POST" }).then(j<ConfigResult>),
  reconnect: () => fetch("/api/board/reconnect", { method: "POST" }).then(j<Status>),
  start: () =>
    fetch("/api/acq/start", { method: "POST" }).then(j<Status & { started: boolean }>),
  recStart: (name: string, timestamp: boolean) =>
    fetch("/api/rec/start", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, timestamp }),
    }).then(j<{ ok: boolean; error?: string; run?: string; status: Status }>),
  recStop: () =>
    fetch("/api/rec/stop", { method: "POST" })
      .then(j<{ ok: boolean; error?: string; run?: string; status: Status }>),
  stop: () => fetch("/api/acq/stop", { method: "POST" }).then(j<Status>),
};

/** Subscribe to telemetry; auto-reconnects. Returns an unsubscribe fn. */
export function openTelemetry(onData: (t: Telemetry) => void): () => void {
  let ws: WebSocket | null = null;
  let retry: number | undefined;
  let closed = false;
  const connect = () => {
    if (closed) return;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(`${proto}://${location.host}/ws/telemetry`);
    ws.onmessage = (e) => {
      try {
        onData(JSON.parse(e.data));
      } catch (err) {
        console.error("unreadable telemetry frame", err);
      }
    };
    ws.onclose = () => { if (!closed) retry = window.setTimeout(connect, 1000); };
    ws.onerror = () => ws?.close();
  };
  connect();
  // Cancel the pending reconnect too. Without this, unsubscribing between a
  // close and its retry left a second socket open with no handle on it - which
  // React's development double-mount does on every page load.
  return () => { closed = true; window.clearTimeout(retry); ws?.close(); };
}
