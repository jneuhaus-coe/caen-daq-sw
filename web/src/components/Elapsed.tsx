import { useEffect, useState } from "react";

/** How long the recording has been running. Ticks locally off a server-supplied
 *  start time, so it stays smooth between telemetry frames. */
export function Elapsed({ since }: { since: number | null }) {
  const [, tick] = useState(0);
  useEffect(() => {
    if (since == null) return;
    const t = window.setInterval(() => tick((n) => n + 1), 1000);
    return () => window.clearInterval(t);
  }, [since]);

  if (since == null) return null;
  const s = Math.max(0, Math.floor(Date.now() / 1000 - since));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return <>{h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`}</>;
}
