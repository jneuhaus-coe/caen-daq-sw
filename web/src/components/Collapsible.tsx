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
      <h2 className="collapse-head" onClick={() => setOpen((o) => !o)}>
        <span className={"chevron" + (open ? " open" : "")}>&#9656;</span>
        {title}
        {right ? <span className="head-right" onClick={(e) => e.stopPropagation()}>{right}</span> : null}
      </h2>
      {open ? <div className="collapse-body">{children}</div> : null}
    </div>
  );
}
