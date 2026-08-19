import { useMemo } from "react";
import type { Telemetry } from "../types";

/** Trigger-rate strip: a bare filled area with no x axis at all, y scaled to the
 *  visible peak. Drawn directly rather than with uPlot — every requirement here
 *  (no x axis, zero pinned to the bottom edge, exactly two y labels, the top one
 *  being the true peak) is something uPlot's axis layout works against. */
export function RateStrip({ tele }: { tele: Telemetry | null }) {
  const rate = tele?.rate.rate ?? [];
  const last = rate.length ? rate[rate.length - 1] : 0;
  const peak = rate.length ? Math.max(...rate) : 0;
  const count = tele?.rate.total ?? 0;

  const paths = useMemo(() => {
    const n = rate.length;
    if (n < 2) return null;
    const H = 100;
    const w = n - 1;
    // Flat along the bottom until something actually triggers.
    const y = (v: number) => (peak > 0 ? H - (v / peak) * H : H);
    const pts = rate.map((v, i) => `${i} ${y(v)}`);
    return {
      w,
      line: `M ${pts.join(" L ")}`,
      area: `M 0 ${H} L ${pts.join(" L ")} L ${w} ${H} Z`,
    };
  }, [rate, peak]);

  return (
    <div className="rate-wrap">
      <div className="rate-num">
        <span className="big mono">{fmt(last)}</span>
        <span className="unit">triggers/s</span>
        <span className="total mono">Count: {count}</span>
      </div>

      <div className="rate-plot">
        {paths ? (
          <svg
            className="rate-svg"
            viewBox={`0 0 ${paths.w} 100`}
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            <path className="rate-area" d={paths.area} />
            <path className="rate-line" d={paths.line} vectorEffect="non-scaling-stroke" />
          </svg>
        ) : null}
        {/* Top label only once there is a real peak to name. */}
        {peak > 0 ? <span className="rate-y top mono">{fmt(peak)}</span> : null}
        <span className="rate-y zero mono">0</span>
      </div>
    </div>
  );
}

/** Exact value, never rounded: a bucket count times the update frequency is a
 *  whole number, and the peak must read as the true peak. */
function fmt(v: number) {
  return Number.isInteger(v) ? String(v) : v.toFixed(1);
}
