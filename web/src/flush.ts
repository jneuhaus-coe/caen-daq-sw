/** Writes held back by a debounce, registered so a deliberate reload (the
 *  one an update asks for) can send them first instead of dropping an edit
 *  made a moment before the click. Each flusher sends whatever it is holding
 *  and resolves once the request is answered; with nothing held, it is a
 *  no-op. */
type Flusher = () => Promise<unknown> | void;

const flushers = new Set<Flusher>();

/** Register a flusher; returns the unregister function (an effect cleanup). */
export function onFlush(flush: Flusher): () => void {
  flushers.add(flush);
  return () => { flushers.delete(flush); };
}

export async function flushAll(): Promise<void> {
  await Promise.allSettled([...flushers].map((flush) => flush()));
}
