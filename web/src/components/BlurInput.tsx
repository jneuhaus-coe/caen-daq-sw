import { useEffect, useRef, useState } from "react";

interface Props {
  value: string | number;
  onCommit: (v: string) => void;
  type?: "text" | "number";
  step?: number;
  min?: number;
  max?: number;
  placeholder?: string;
  autoFocus?: boolean;
  className?: string;
  disabled?: boolean;
  onCancel?: () => void;
  /** Canonical display text for what was typed, e.g. the reachable step it
   *  lands on. Without it the field falls back to the current value. */
  format?: (raw: string) => string;
  /** Address-bar behaviour: the first click into an unfocused field selects
   *  the whole value (so it can be copied or typed over), while a click in an
   *  already-focused field places the caret and dragging selects a range.
   *  Stepping with the spinner or arrow keys re-selects the new value. */
  selectOnFocus?: boolean;
}

/** An input that commits on blur or Enter, not on every keystroke.
 *
 *  Settings here go to the hardware, so committing per character would fire a
 *  write for every digit typed. Enter commits and KEEPS focus, with the text
 *  selected, so a value can be tweaked again straight away (it used to blur,
 *  which made iterating on a setting a click per try). Escape reverts. While
 *  focused the draft is left alone - except to show what an Enter commit
 *  landed on - so a value arriving from the board mid-edit does not yank the
 *  field out from under the typist. */
export function BlurInput({
  value, onCommit, onCancel, type = "text", step, min, max,
  placeholder, autoFocus, className, disabled, selectOnFocus, format,
}: Props) {
  const [draft, setDraft] = useState(String(value));
  const editing = useRef(false);
  // Set by an Enter commit: the next value from the board replaces the draft
  // even though the field still has focus.
  const awaiting = useRef(false);
  const valueRef = useRef(value);
  valueRef.current = value;
  const ref = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!editing.current) {
      setDraft(String(value));
    } else if (awaiting.current) {
      awaiting.current = false;
      setDraft(String(value));
      reselect.current = true;
    }
  }, [value]);

  useEffect(() => {
    if (autoFocus && ref.current) {
      ref.current.focus();
      ref.current.select();
    }
  }, [autoFocus]);

  // True between mousedown-on-an-unfocused-field and its mouseup.
  const claiming = useRef(false);
  // Set when a value change came from stepping rather than typing.
  const reselect = useRef(false);

  useEffect(() => {
    if (reselect.current) {
      reselect.current = false;
      ref.current?.select();
    }
  });

  return (
    <input
      ref={ref}
      className={className}
      type={type}
      step={step}
      min={min}
      max={max}
      disabled={disabled}
      placeholder={placeholder}
      value={draft}
      onFocus={() => { editing.current = true; }}
      onMouseDown={(e) => {
        // Only the click that *gives* focus should select everything.
        claiming.current = selectOnFocus === true
          && document.activeElement !== e.currentTarget;
      }}
      onMouseUp={(e) => {
        if (!claiming.current) return;
        claiming.current = false;
        const el = e.currentTarget;
        // Never preventDefault here. On a number input the spinner's press-and-
        // hold repeat is torn down by the default mouseup action, so cancelling
        // it leaves the arrow auto-repeating as if the button were still held.
        // Defer instead, and let the browser finish first.
        requestAnimationFrame(() => {
          // A drag already chose a range - leave the user's selection alone.
          if (el.isConnected && el.selectionStart === el.selectionEnd) el.select();
        });
      }}
      onChange={(e) => {
        // Typing/pasting carries an inputType; the spinner and arrow-key
        // stepping do not. Only stepping should re-select.
        const it = (e.nativeEvent as InputEvent).inputType;
        if (selectOnFocus && !it) reselect.current = true;
        setDraft(e.target.value);
      }}
      onBlur={() => {
        editing.current = false;
        awaiting.current = false;
        if (draft !== String(value)) {
          // Show where it actually landed straight away, so the field never
          // displays text the value never became - and never flashes the old
          // value on the way to the new one.
          const canonical = format ? format(draft) : String(value);
          onCommit(draft);
          setDraft(canonical);
        } else {
          onCancel?.();
        }
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          if (draft !== String(value)) {
            awaiting.current = true;
            onCommit(draft);
            // A commit that lands on the value already held (a clamp to
            // the current setting) never changes `value`, so nothing would
            // replace the typed text: show what is held after a moment.
            window.setTimeout(() => {
              if (!awaiting.current) return;
              awaiting.current = false;
              setDraft(String(valueRef.current));
              reselect.current = true;
            }, 800);
          }
          e.currentTarget.select();
          return;
        }
        if (e.key === "Escape") {
          setDraft(String(value));
          editing.current = false;
          onCancel?.();
          e.currentTarget.blur();
        }
      }}
    />
  );
}
