import { useEffect, useState, type Dispatch, type SetStateAction } from "react";

/** Where a value lives between page loads.
 *  - "local": a remembered last-used value, shared by every window on this
 *    machine and kept across restarts (run name, scope rate, open panels).
 *  - "session": a draft belonging to ONE window - it survives that window's
 *    reload (the one an update asks for) and dies with it (a typed run-number
 *    override, an unsent run note). Two windows must never share those. */
export type Persistence = "local" | "session";

const PREFIX = "daq:";

function store(kind: Persistence): Storage | null {
  try {
    return kind === "local" ? window.localStorage : window.sessionStorage;
  } catch {
    return null;                 // storage blocked: behave like plain state
  }
}

function read<T>(kind: Persistence, key: string, fallback: T): T {
  try {
    const raw = store(kind)?.getItem(PREFIX + key);
    if (raw == null) return fallback;
    const value = JSON.parse(raw);
    // A stored value of the wrong shape (an older build's) is ignored, not
    // trusted: a string where a boolean belongs would reach the controls.
    return typeof value === typeof fallback ? (value as T) : fallback;
  } catch {
    return fallback;
  }
}

/** useState that survives a page reload. Values must be JSON-serialisable
 *  and keep one type; the key is namespaced, so it only needs to be unique
 *  within this app. */
export function usePersistentState<T>(key: string, initial: T,
                                      kind: Persistence = "local"):
    [T, Dispatch<SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => read(kind, key, initial));
  useEffect(() => {
    try {
      store(kind)?.setItem(PREFIX + key, JSON.stringify(value));
    } catch { /* full or blocked: the value still works for this page */ }
  }, [kind, key, value]);
  return [value, setValue];
}
