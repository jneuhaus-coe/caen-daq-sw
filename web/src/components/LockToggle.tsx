interface Props {
  locked: boolean;
  onToggle: () => void;
  /** What is being locked, for screen readers ("TR DC offset"). */
  what: string;
}

/** The house-style lock: an icon button LEFT of a setting's label. Locking
 *  only stops edits from this UI - it never writes, resets or hides the
 *  value, and one click unlocks it again.
 *
 *  A line icon in currentColor, so it reads exactly like the label beside it
 *  (muted with it when locked) instead of a coloured emoji that looked like a
 *  separate, highlighted control. */
export function LockToggle({ locked, onToggle, what }: Props) {
  return (
    <button type="button" className="lock-toggle"
      aria-label={locked ? `Unlock ${what}` : `Lock ${what}`}
      aria-pressed={locked}
      title={locked ? "Locked - click to allow changing this setting via the UI"
                    : "Click to lock this setting, preventing changes from the UI"}
      onClick={onToggle}>
      <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"
        fill="none" stroke="currentColor" strokeWidth="1.5"
        strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="7" width="10" height="7" rx="1.5" />
        {/* Closed shackle, or swung open to the right. */}
        <path d={locked ? "M5 7V5a3 3 0 0 1 6 0v2" : "M5 7V5a3 3 0 0 1 5.8-1"} />
      </svg>
    </button>
  );
}
