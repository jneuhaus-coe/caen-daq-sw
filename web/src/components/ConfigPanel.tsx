import { useRef, useState } from "react";
import type { BoardConfig } from "../types";

export interface LoadResult {
  config: BoardConfig;
  notes: string[];
  errors: string[];
  restart: string[];
  connected: boolean;
  running: boolean;
}

interface Props {
  onLoaded: (r: LoadResult) => void;
  onReset: () => void;
}

/** Button order follows the usual guidance: order by priority, and keep a
 *  destructive action away from the ones next to it so it is not hit by
 *  accident. Load and Save are the working pair (File-menu order: open, then
 *  save); Reset discards everything, so it sits apart on the right. */
export function ConfigPanel({ onLoaded, onReset }: Props) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [msg, setMsg] = useState<{ kind: "ok" | "warn" | "err"; lines: string[] } | null>(null);

  const save = () => {
    // A real download, not a copy-paste blob. The name comes from the server's
    // Content-Disposition, which wins over a download attribute for a
    // same-origin response - so setting one here would only look like it works.
    const a = document.createElement("a");
    a.href = "/api/config/file";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setMsg({ kind: "ok", lines: ["Saved the settings the unit currently holds."] });
  };

  const load = async (file: File) => {
    setMsg(null);
    let r: any;
    try {
      const text = await file.text();
      const res = await fetch("/api/config/file", {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: text,
      });
      r = await res.json();
      if (!res.ok) throw new Error(r?.detail ?? `${res.status} ${res.statusText}`);
    } catch (e) {
      setMsg({ kind: "err",
               lines: [`Could not load ${file.name}.`,
                       e instanceof Error ? e.message : String(e)] });
      return;
    }

    const errors: string[] = r.errors ?? [];
    const notes: string[] = r.notes ?? [];
    if (r.parsed === false) {
      // The file never read, so nothing was sent and nothing changed. The
      // server returns the current config on this path too, so it has to say
      // which failure this was - otherwise both look like a successful load.
      setMsg({ kind: "err",
               lines: [`Could not read ${file.name}.`,
                       ...(errors.length ? errors : ["It is not a config file this app knows."])] });
      return;
    }
    // The unit may have refused part of the file - but what it reports back is
    // its state either way, so it is always adopted. Returning early here left
    // the UI showing settings the hardware no longer had.
    onLoaded({ config: r.config, notes, errors, restart: r.restart ?? [],
               connected: r.connected !== false, running: !!r.running });
    if (r.connected === false) {
      setMsg({ kind: "err",
               lines: [`Read ${file.name}, but no unit is connected - nothing was sent.`] });
    } else if (errors.length) {
      setMsg({ kind: "err", lines: [`Loaded ${file.name}; the unit refused:`, ...errors, ...notes] });
    } else {
      setMsg({ kind: notes.length ? "warn" : "ok",
               lines: [`Loaded ${file.name}.`, ...notes] });
    }
  };

  return (
    <div className="card">
      <h2>Config file</h2>
      <div className="config-btns">
        <button onClick={() => fileRef.current?.click()}>Load…</button>
        <button onClick={save}>Save…</button>
        <span className="spacer" />
        <button className="danger" onClick={onReset}>Reset</button>
      </div>
      <input
        ref={fileRef} type="file" accept=".json,.txt,.conf,text/plain,application/json"
        style={{ display: "none" }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) load(f);
          e.target.value = "";      // let the same file be picked twice
        }}
      />
      <p className="muted">
        The panels above configure the unit directly; files exist to carry a
        setup between machines. Load accepts this app's JSON, a CAEN{" "}
        <code>WaveDumpConfig.txt</code>, or the group's legacy format{" "}
        (<code>CHNOFFSE&nbsp;…</code>); everything loaded is written to the
        unit and read back.
      </p>
      {msg ? (
        <div className={"config-msg " + msg.kind}>
          {msg.lines.map((l, i) => <div key={i}>{l}</div>)}
        </div>
      ) : null}
    </div>
  );
}
