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

/** An input that commits on blur, not on every keystroke.
 *
 *  Settings here go to the hardware, so committing per character would fire a
 *  write for every digit typed. Enter commits, Escape reverts. While focused the
 *  draft is left alone, so a value arriving from the board mid-edit does not
 *  yank the field out from under the typist. */
export function BlurInput({
  value, onCommit, onCancel, type = "text", step, min, max,
  placeholder, autoFocus, className, selectOnFocus, format,
}: Props) {
  const [draft, setDraft] = useState(String(value));
  const editing = useRef(false);
  const ref = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!editing.current) setDraft(String(value));
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
        if (e.key === "Enter") e.currentTarget.blur();
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
