import { useEffect, useRef, useState } from "react";
import { usePersistentState } from "../persist";
import { api } from "../api";
import type { CalibrationStatus } from "../api";
import type { ZeroCal } from "../types";
import { LockToggle } from "./LockToggle";

interface Props {
  connected: boolean;
  /** The server says a calibration is running - possibly started in another
   *  window, which this panel's own poll (idle while nothing runs) would
   *  otherwise never notice. */
  active?: boolean;
  recording: boolean;
  /** Calibration steers DC offsets, so it locks like a setting does. */
  locked?: boolean;
  onToggleLock?: () => void;
  /** A run began - here or in another window; the app wipes the piles. */
  onStarted?: () => void;
  /** Called when a run finishes: the server changed the config underneath the
   *  UI, so the App must re-fetch what the board now holds. */
  onFinished: (st: CalibrationStatus) => void;
  onError: (title: string, lines?: string[]) => void;
  /** The open unit's per-board 0 V calibration, when one is stored. */
  zc?: ZeroCal | null;
}

/** Channel setup, polarity-agnostic - the data says where the pulse goes,
 *  not a setting:
 *
 *  Pulse Shift: with real triggers flowing, every channel goes to 0 V of
 *  offset; only a channel whose pulse clips there is moved, just far enough
 *  to bring the whole pulse into the window. Never centres anything.
 *  Zero-volt calibration: measures each input's real 0 V reading for the
 *  plots (display only). */
export function CalibrationPanel({ connected, active, recording, locked, onToggleLock,
                                   onStarted, onFinished, onError, zc }: Props) {
  const [st, setSt] = useState<CalibrationStatus | null>(null);
  const [fitEvents, setFitEvents] = usePersistentState("calFitEvents", "100");
  const [zcHelp, setZcHelp] = useState(false);
  const wasActive = useRef(false);

  // Poll while a run is active - also on mount, so a page opened mid-run
  // picks the progress up rather than showing a dead panel.
  useEffect(() => {
    let cancelled = false;
    let timer: number | undefined;
    const tick = async () => {
      try {
        const s = await api.calibrateStatus();
        if (cancelled) return;
        setSt(s);
        if (s.active) {
          timer = window.setTimeout(tick, 600);
          // A run that began elsewhere (another window) wipes here too.
          if (!wasActive.current) onStarted?.();
        } else if (wasActive.current) {
          wasActive.current = false;
          onFinished(s);
        }
        if (s.active) wasActive.current = true;
      } catch {
        // The server is away - a restart, a network blip. Keep asking: a
        // poll loop that dies here freezes the panel on its last state,
        // which once left an uncancellable ghost spinner after a redeploy
        // killed the server mid-run.
        if (!cancelled) timer = window.setTimeout(tick, 1500);
      }
    };
    tick();
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [st?.active, active]);   // re-arm the poll loop when activity flips

  const run = async (mode: "shift" | "zero") => {
    try {
      const n = mode === "shift" ? Number(fitEvents) : null;
      await api.calibrate(mode, Number.isFinite(n as number) && (n as number) > 0 ? n : null);
      onStarted?.();
      wasActive.current = true;
      setSt((s) => s ? { ...s, active: true, phase: mode, message: "starting" }
                    : { active: true, phase: mode, message: "starting",
                        iteration: 0, report: [], error: null });
    } catch (e) {
      onError("Could not start the calibration", [String(e)]);
    }
  };

  const cancelRun = async () => {
    // "No calibration is running" is an answer, not a failure: the panel
    // may be showing a run the server no longer knows about. Either way,
    // re-fetch the truth so Cancel always resolves what is on screen.
    try { await api.calibrateCancel(); } catch { /* resolved below */ }
    try { setSt(await api.calibrateStatus()); } catch { /* the poll retries */ }
  };

  const busy = !!st?.active;
  const rows = st?.report ?? [];
  // "shifted" is a success too: Pulse Shift moved a clipped channel into view.
  const bad = rows.filter((r) => r.status !== "ok" && r.status !== "shifted");
  const zeroReport = st?.phase === "zero";
  const zcOn = !!zc?.applied;
  const zcWhen = zc?.measured_at?.replace("T", " ").slice(0, 16);

  return (
    <div className="card">
      <h2>Calibration</h2>
      <div className="calib-btns">
        {onToggleLock ? (
          <LockToggle locked={!!locked} what="calibration" onToggle={onToggleLock} />
        ) : null}
        <button disabled={!connected || busy || recording || locked} onClick={() => run("shift")}
          title="Only changes the DC offset, to slide a clipped pulse back into the ADC window. Channels that fit at 0 V of offset stay there. Needs real triggers.">
          Pulse Shift <span className="calib-note">needs triggers</span>
        </button>
        <label className="calib-events"
          title="Triggered events per Pulse Shift measurement. It waits however long they take; it only stops if nothing triggers for 30 s.">
          <input type="number" min={4} value={fitEvents}
            disabled={busy}
            onChange={(e) => setFitEvents(e.target.value)} />
          ev
        </label>
      </div>
      <div className="zc-row">
        <span className={"zc-state" + (zcOn ? " on" : "")}
          title={zcOn
            ? `This board's 0 V levels (measured ${zcWhen}) are applied to the plots only, not to recorded data.`
            : "No 0 V calibration for this board: plots use CAEN's nominal 0 V levels."}>
          <span className="dot" />
          0 V levels: {zcOn ? "board-calibrated" : "nominal"}
        </span>
        <button disabled={!connected || busy || recording || locked} onClick={() => run("zero")}
          title="Find the ADC code a 0 V input reads on every channel and TR0. Unplug every input first.">
          {zcOn ? "Re-calibrate 0 V" : "Calibrate 0 V"}
        </button>
        <button className="zc-help" aria-label="About zero-volt calibration"
          title="What this is and how to do it" onClick={() => setZcHelp(true)}>?</button>
      </div>
      {busy ? (
        <p className="calib-progress">
          <span className="spinner" /> {st!.phase}: {st!.message}
          <button className="calib-cancel"
            title="Stop at the next safe point; the board keeps the last completed pass"
            onClick={cancelRun}>
            Cancel
          </button>
        </p>
      ) : null}
      {st?.error ? <p className="calib-error">{st.error}</p> : null}
      {!busy && rows.length && zeroReport ? (
        <div className="calib-report">
          <div className="calib-sum">
            0 V found for {rows.length - bad.length} of {rows.length} inputs
            {bad.length ? ` - not saved for: ${bad.map((r) => r.channel).join(", ")}` : ""}
          </div>
          <table>
            <tbody>
              {rows.map((r) => (
                <tr key={r.channel} className={r.status !== "ok" ? "bad" : ""}>
                  <td>{r.channel}</td>
                  <td className="mono" title="ADC code a 0 V input reads at this DC offset">
                    {r.zero_code != null ? `0 V @ ${r.zero_code}` : "-"}</td>
                  <td className="mono muted">
                    {r.ref_dac != null ? `offset 0x${r.ref_dac.toString(16).toUpperCase()}` : ""}</td>
                  <td>{r.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {!busy && rows.length && !zeroReport ? (
        <div className="calib-report">
          <div className="calib-sum">
            {rows.filter((r) => r.status === "ok").length} of {rows.length} fit at 0 V of offset
            {rows.some((r) => r.status === "shifted")
              ? ` - shifted: ${rows.filter((r) => r.status === "shifted").map((r) => r.channel).join(", ")}` : ""}
            {bad.length ? ` - attention: ${bad.map((r) => r.channel).join(", ")}` : ""}
          </div>
          <table>
            <tbody>
              {rows.map((r) => (
                <tr key={r.channel} className={r.status !== "ok" ? "bad" : ""}>
                  <td>{r.channel}</td>
                  <td className="mono">{r.baseline_mv != null ? `${r.baseline_mv} mV` : "-"}</td>
                  <td className="mono" title="Measured excursion below / above the baseline">
                    -{r.below_mv}/+{r.above_mv}
                  </td>
                  <td>{r.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      <p className="muted">
        Save a session afterwards to give the converged state a name.
      </p>
      {zcHelp ? (
        <div className="modal-backdrop" onClick={() => setZcHelp(false)}>
          <div className="modal zc-modal" role="dialog" aria-label="Zero-Volt Calibration"
            onClick={(e) => e.stopPropagation()}>
            <h3>Zero-Volt Calibration</h3>
            <p>
              Each digitizer reads a 0&nbsp;V input slightly off CAEN's nominal
              value, sometimes by over 100&nbsp;mV. This measures the true
              0&nbsp;V reading on every channel and TR0 and corrects the plots
              to match. Recorded data is not changed.
            </p>
            <p>
              The calibration result is saved on this computer for the
              connected digitizer and is applied automatically whenever that
              digitizer is connected.
            </p>
            <p>To calibrate:</p>
            <ol>
              <li>Disconnect all inputs, including TR0, or fit 50&nbsp;&Omega;
                terminators.</li>
              <li>Click <b>Calibrate 0 V</b>. It takes a few seconds, and
                your settings are restored when it finishes.</li>
              <li>Reconnect your inputs.</li>
            </ol>
            <p>
              If any input carries a signal during the measurement, the
              calibration is not saved, and the affected inputs are listed
              below the button.
            </p>
            <div className="modal-btns">
              <button className="primary" onClick={() => setZcHelp(false)}>OK</button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
