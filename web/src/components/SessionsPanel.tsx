import { useEffect, useState } from "react";
import { api } from "../api";
import type { DisplayPrefs, SessionInfo } from "../api";
import type { BoardConfig } from "../types";

interface Props {
  recording: boolean;
  onApplied: (cfg: BoardConfig, display: DisplayPrefs,
              errors: string[], connected: boolean, name: string) => void;
  onError: (title: string, lines?: string[]) => void;
  onSaved: (name: string) => void;
}

/** Named snapshots of the whole operator-facing state: board config (channel
 *  names included) plus the display ranges. Hardware settings already survive
 *  daq restarts on the unit itself; a session is the one click back to a known
 *  state after a board power-cycle - and a name ("cosmics-nov") for it.
 *
 *  Apply is deliberately blocked while recording: rewriting offsets under a
 *  run corrupts the data it is collecting. */
export function SessionsPanel({ recording, onApplied, onError, onSaved }: Props) {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  const refresh = () =>
    api.listSessions().then((r) => setSessions(r.sessions)).catch(() => {});
  useEffect(() => { refresh(); }, []);

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

  return (
    <div className="card">
      <h2>Sessions</h2>
      <div className="session-save">
        <input value={name} placeholder="e.g. cosmics-nov"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") save(); }} />
        <button disabled={busy || !name.trim()} onClick={save}
          title="Snapshot the current settings and display under this name">
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
              <button className="danger" onClick={() => remove(s.name)}
                title="Delete this session">&times;</button>
            </div>
          ))}
        </div>
      ) : (
        <p className="muted">No sessions saved yet.</p>
      )}
      <p className="muted">
        The unit keeps its settings across daq restarts on its own; a session
        is the one click back after a board power-cycle.
      </p>
    </div>
  );
}
