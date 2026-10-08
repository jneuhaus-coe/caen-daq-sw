interface Props {
  locked: boolean;
  onToggle: () => void;
  /** What is being locked, for screen readers ("TR DC offset"). */
  what: string;
}

/** The house-style lock: an icon button LEFT of a setting's label. Locking
 *  only stops edits from this UI - it never writes, resets or hides the
 *  value, and one click unlocks it again. */
export function LockToggle({ locked, onToggle, what }: Props) {
  return (
    <button type="button" className="lock-toggle"
      aria-label={locked ? `Unlock ${what}` : `Lock ${what}`}
      aria-pressed={locked}
      title={locked ? "Locked - click to allow changing this setting via the UI"
                    : "Click to lock this setting, preventing changes from the UI"}
      onClick={onToggle}>{locked ? "🔒" : "🔓"}</button>
  );
}
