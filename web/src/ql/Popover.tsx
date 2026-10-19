import { useEffect, useId, useRef, useState, type ReactNode } from "react";

/** A button that opens a small panel under it: the one way Quick Look
 *  offers a menu richer than a <select>. Closes on Escape (focus returns
 *  to the button), on a click outside, or when the content calls close(). */
export function Popover({ label, ariaLabel, className = "ql-slot", align = "left", children }: {
  label: ReactNode;
  ariaLabel: string;
  className?: string;
  align?: "left" | "right";
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLSpanElement | null>(null);
  const button = useRef<HTMLButtonElement | null>(null);
  const id = useId();
  const close = () => { setOpen(false); button.current?.focus(); };

  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => {
      if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", down);
    return () => document.removeEventListener("pointerdown", down);
  }, [open]);

  return (
    <span className="ql-popover" ref={wrap}
      onKeyDown={(e) => { if (e.key === "Escape" && open) { e.stopPropagation(); close(); } }}>
      <button ref={button} type="button" className={className} aria-label={ariaLabel}
        aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined}
        onClick={() => setOpen((o) => !o)}>
        {label}<span className="ql-caret" aria-hidden="true">▾</span>
      </button>
      {open ? (
        <div id={id} role="dialog" aria-label={ariaLabel} className={"ql-menu" + (align === "right" ? " right" : "")}>
          {children(close)}
        </div>
      ) : null}
    </span>
  );
}
