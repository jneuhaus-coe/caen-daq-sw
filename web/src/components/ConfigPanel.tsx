import { useRef, useState } from "react";
import type { BoardConfig } from "../types";

interface Props {
  onLoaded: (cfg: BoardConfig, notes: string[], restart: string[], running: boolean) => void;
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
    // A real download, named and dated, not a copy-paste blob.
    const a = document.createElement("a");
    a.href = "/api/config/file";
    a.download = `daq-config-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setMsg({ kind: "ok", lines: ["Saved current settings."] });
  };

  const load = async (file: File) => {
    setMsg(null);
    const text = await file.text();
    const r = await fetch("/api/config/file", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: text,
    }).then((x) => x.json());

    if (!r.ok && r.errors?.length) {
      setMsg({ kind: "err", lines: r.errors });
      return;
    }
    onLoaded(r.config, r.notes ?? [], r.restart ?? [], !!r.running);
    const lines = [`Loaded ${file.name}.`, ...(r.notes ?? [])];
    setMsg({ kind: r.notes?.length ? "warn" : "ok", lines });
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
