import { useState, type ReactNode } from "react";

interface Props {
  title: string;
  children: ReactNode;
  defaultOpen?: boolean;
  right?: ReactNode;
  /** "card" is a top-level panel; "nested" sits inside one without its own chrome. */
  variant?: "card" | "nested";
}

export function Collapsible({ title, children, defaultOpen = false, right, variant = "card" }: Props) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={variant === "card" ? "card" : "sub-collapse"}>
      {/* A real button, not a clickable heading: these are the only way to
          reach the settings, and a bare <h2 onClick> cannot be tabbed to or
          opened from the keyboard at all. */}
      <h2 className="collapse-head">
        <button type="button" className="collapse-toggle" aria-expanded={open}
          onClick={() => setOpen((o) => !o)}>
          <span className={"chevron" + (open ? " open" : "")}>&#9656;</span>
          {title}
        </button>
        {right ? <span className="head-right" onClick={(e) => e.stopPropagation()}>{right}</span> : null}
      </h2>
      {open ? <div className="collapse-body">{children}</div> : null}
    </div>
  );
}
