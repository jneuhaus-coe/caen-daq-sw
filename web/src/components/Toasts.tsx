import { useCallback, useEffect, useRef, useState } from "react";

export interface Toast {
  id: number;
  kind: "ok" | "warn" | "err";
  title: string;
  lines?: string[];
}

const LIFETIME = { ok: 2600, warn: 5000, err: 8000 };

export function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const next = useRef(1);

  const dismiss = useCallback((id: number) => {
    setToasts((t) => t.filter((x) => x.id !== id));
  }, []);

  const push = useCallback((kind: Toast["kind"], title: string, lines?: string[]) => {
    const id = next.current++;
    // Keep the stack short; the newest is the one that matters.
    setToasts((t) => [...t.slice(-3), { id, kind, title, lines }]);
    return id;
  }, []);

  return { toasts, push, dismiss };
}

export function Toasts({ toasts, onDismiss }: { toasts: Toast[]; onDismiss: (id: number) => void }) {
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => <ToastItem key={t.id} toast={t} onDismiss={onDismiss} />)}
    </div>
  );
}

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: (id: number) => void }) {
  const [hover, setHover] = useState(false);
  useEffect(() => {
    if (hover) return;                       // don't expire under the cursor
    const t = window.setTimeout(() => onDismiss(toast.id), LIFETIME[toast.kind]);
    return () => window.clearTimeout(t);
  }, [hover, toast.id, toast.kind, onDismiss]);

  return (
    <div className={"toast " + toast.kind}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={() => onDismiss(toast.id)}>
      <span className="toast-mark">{toast.kind === "ok" ? "✓" : toast.kind === "warn" ? "!" : "×"}</span>
      <div className="toast-body">
        <div className="toast-title">{toast.title}</div>
        {toast.lines?.map((l, i) => <div key={i} className="toast-line mono">{l}</div>)}
      </div>
    </div>
  );
}
