import type { Status } from "../types";

interface Props {
  status: Status | null;
  /** false once the status poll itself stops answering */
  serverUp: boolean;
  busy: boolean;
  onReconnect: () => void;
}

/** Header badge: is a board there, and which one. Green only when we can
 *  currently talk to the unit — never on stale info. */
export function ConnectionBadge({ status, serverUp, busy, onReconnect }: Props) {
  const connected = serverUp && !!status?.opened;
  const b = status?.board;

  const state = busy ? "busy" : connected ? "ok" : "bad";
  const label = busy
    ? "Connecting…"
    : connected
      ? b?.model || "board"
      : serverUp
        ? "No board"
        : "Server offline";

  // Everything we know about the unit, for the hover.
  const detail = connected && b
    ? [
        `${b.model}  family ${b.family}`,
        `S/N ${b.serial}`,
        `ROC ${b.roc_firmware}`,
        `AMC ${b.amc_firmware}`,
        b.sw_release ? `Lib ${b.sw_release}` : null,
      ].filter(Boolean).join("\n")
    : serverUp
      ? "No digitizer is open. Power the unit on, then press Reconnect."
      : "Cannot reach the DAQ server.";

  return (
    <span className={`conn ${state}`} title={detail}>
      <i className="dot" />
      <span className="conn-label">{label}</span>
      {connected && b ? (
        <span className="conn-sn mono">S/N:{b.serial}</span>
      ) : null}
      {!connected && !busy ? (
        <button className="mini conn-btn" onClick={onReconnect}>Reconnect</button>
      ) : null}
    </span>
  );
}
