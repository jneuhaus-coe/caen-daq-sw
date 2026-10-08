import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { DisplayPrefs, SessionInfo } from "../api";
import type { BoardConfig } from "../types";

interface Props {
  recording: boolean;
  onApplied: (cfg: BoardConfig, display: DisplayPrefs,
              errors: string[], connected: boolean, name: string) => void;
  onError: (title: string, lines?: string[]) => void;
  onSaved: (name: string) => void;
  onImported: (name: string, kind: "session" | "config", notes: string[]) => void;
}

/** Named snapshots of the whole operator-facing state: board config (channel
 *  names included) plus the display ranges and the experiment conditions.
 *  Hardware settings already survive daq restarts on the unit itself; a
 *  session is the one click back to a known state after a board power-cycle
 *  - and a name ("cosmics-nov") for it.
 *
 *  Each row: Apply, and a More menu (Download the session, Export just its
 *  board config, Delete). Import, once for the card, adds a file to the list
 *  - never to the unit.
 *
 *  Apply is deliberately blocked while recording: rewriting offsets under a
 *  run corrupts the data it is collecting. */
export function SessionsPanel({ recording, onApplied, onError, onSaved, onImported }: Props) {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const refresh = () =>
    api.listSessions().then((r) => setSessions(r.sessions)).catch(() => {});
  useEffect(() => { refresh(); }, []);

  // The menu closes on a click anywhere else, or Escape.
  useEffect(() => {
    if (menuFor == null) return;
    const down = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuFor(null);
    };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") setMenuFor(null); };
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", down);
      document.removeEventListener("keydown", key);
    };
  }, [menuFor]);

  const save = async () => {
    const n = name.trim();
    if (!n) return;
    setBusy(true);
    try {
      const r = await api.saveSession(n);
      setName("");
      onSaved(r.name);
      await refresh();
    } catch {
      onError("Could not save the session");
    } finally {
      setBusy(false);
    }
  };

  const apply = async (n: string) => {
    setBusy(true);
    try {
      const r = await api.applySession(n);
      onApplied(r.config, r.display, r.errors ?? [], r.connected, n);
    } catch (e) {
      onError(`Could not apply "${n}"`, [String(e)]);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (n: string) => {
    if (!confirm(`Delete the session "${n}"?\n\nThis cannot be undone.`)) return;
    try {
      await api.deleteSession(n);
      await refresh();
    } catch {
      onError(`Could not delete "${n}"`);
    }
  };

  // A real download: the server's Content-Disposition names the file.
  const download = (url: string) => {
    const a = document.createElement("a");
    a.href = url;
    document.body.appendChild(a);
    a.click();
    a.remove();
  };

  const importFile = async (file: File) => {
    try {
      const r = await api.importSession(await file.text(), file.name);
      await refresh();
      onImported(r.name, r.kind, r.notes ?? []);
    } catch (e) {
      onError(`Could not import ${file.name}`,
              [e instanceof Error ? e.message : String(e)]);
    }
  };

  return (
    <div className="card">
      <h2>Sessions</h2>
      <div className="session-save">
        <input value={name} placeholder="e.g. cosmics-nov"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") save(); }} />
        <button disabled={busy || !name.trim()} onClick={save}
          title="Snapshot the current settings, display and experiment conditions under this name">
          Save session
        </button>
      </div>
      {sessions.length ? (
        <div className="session-list">
          {sessions.map((s) => (
            <div className="session-row" key={s.name}>
              <span className="session-name" title={s.name}>{s.name}</span>
              <span className="session-date">
                {s.saved_at ? new Date(s.saved_at * 1000).toLocaleString() : ""}
              </span>
              <button disabled={busy || recording} onClick={() => apply(s.name)}
                title={recording
                  ? "Stop the recording first - applying settings under a run corrupts it"
                  : "Write this session to the unit and restore its display"}>
                Apply
              </button>
              <div className="session-more" ref={menuFor === s.name ? menuRef : undefined}>
                <button aria-haspopup="menu" aria-expanded={menuFor === s.name}
                  onClick={() => setMenuFor(menuFor === s.name ? null : s.name)}>
                  More &#9662;
                </button>
                {menuFor === s.name ? (
                  <div className="session-menu" role="menu">
                    <button role="menuitem"
                      title="Save this session as a file - Import brings it back, here or on another DAQ"
                      onClick={() => { setMenuFor(null); download(api.sessionFileUrl(s.name)); }}>
                      Download
                    </button>
                    <button role="menuitem"
                      title="Save only this session's board settings, as a config file"
                      onClick={() => { setMenuFor(null); download(api.sessionConfigUrl(s.name)); }}>
                      Export Board Config
                    </button>
                    <button role="menuitem" className="danger"
                      onClick={() => { setMenuFor(null); remove(s.name); }}>
                      Delete
                    </button>
                  </div>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="muted">No sessions saved yet.</p>
      )}
      <div className="session-import">
        <button onClick={() => fileRef.current?.click()}
          title="Add a file to this list: a downloaded session, or a board config (this app's, a WaveDumpConfig.txt, or the legacy format). Nothing is sent to the unit until you Apply it.">
          Import…
        </button>
        <span className="muted">a session or a board config file</span>
      </div>
      <input ref={fileRef} type="file"
        accept=".json,.txt,.conf,text/plain,application/json"
        style={{ display: "none" }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) importFile(f);
          e.target.value = "";      // let the same file be picked twice
        }} />
      <p className="muted">
        The unit keeps its settings across daq restarts on its own; a session
        is the one click back after a board power-cycle.
      </p>
    </div>
  );
}
