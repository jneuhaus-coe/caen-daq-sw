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
  // An open in progress is not "no board": saying so sent operators off to
  // power-cycle a unit that was mid-connect, restarting the wait.
  const link = serverUp && !connected ? status?.link : undefined;
  const opening = busy || link?.state === "opening";

  const state = opening ? "busy" : connected ? "ok" : "bad";
  const label = opening
    ? "Connecting…"
    : connected
      ? b?.model || "board"
      : !serverUp
        ? "Server offline"
        : link?.state === "waiting"
          ? "Waiting for unit"
          : "No board";

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
      ? (link?.detail ? link.detail + "\n\n" : "")
        + "It reconnects by itself once the unit is on and booted."
      : "Cannot reach the DAQ server.";

  return (
    <span className={`conn ${state}`} title={detail}>
      <i className="dot" />
      <span className="conn-label">{label}</span>
      {connected && b ? (
        <span className="conn-sn mono">S/N:{b.serial}</span>
      ) : null}
      {!connected && !opening ? (
        <button className="mini conn-btn" onClick={onReconnect}>Reconnect</button>
      ) : null}
    </span>
  );
}
