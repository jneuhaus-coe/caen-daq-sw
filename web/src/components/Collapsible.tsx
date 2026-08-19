import { useState, type ReactNode } from "react";

interface Props { title: string; children: ReactNode; defaultOpen?: boolean; right?: ReactNode; }

export function Collapsible({ title, children, defaultOpen = false, right }: Props) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="card">
      <h2 className="collapse-head" onClick={() => setOpen((o) => !o)}>
        <span className={"chevron" + (open ? " open" : "")}>▸</span>
        {title}
        {right ? <span className="head-right" onClick={(e) => e.stopPropagation()}>{right}</span> : null}
      </h2>
      {open ? <div className="collapse-body">{children}</div> : null}
    </div>
  );
}
