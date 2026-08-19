import { useEffect, useRef } from "react";

interface Props {
  wave?: number[];
  /** Signed per-channel trim; positions 0 V within the ADC window. */
  dcOffset: number;
  adcMax: number;
  rangeVpp: number;
  dcHalfSpan: number;
  windowNs?: number;  // full record length in ns, for the time axis
  height?: number;
  color: string;
}

/** One channel's averaged waveform on the FULL 0..adcMax window - never
 * autoscaled, so a railed or badly-offset channel is obvious at a glance.
 *
 * Axis labels are HTML rather than canvas text: crisper, and they stay put
 * without re-measuring on every repaint. */
export function MiniWave({
  wave, dcOffset, adcMax, rangeVpp, dcHalfSpan, windowNs, height = 140, color,
}: Props) {
  const ref = useRef<HTMLCanvasElement | null>(null);

  // Where 0 V sits in ADC counts: a positive trim lifts the baseline.
  const zeroCounts = (adcMax / 2) * (1 + dcOffset / dcHalfSpan);
  const voltsAt = (counts: number) => (counts - zeroCounts) * (rangeVpp / (adcMax + 1));
  const zeroFrac = Math.min(1, Math.max(0, zeroCounts / adcMax));

  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth, h = height;
    if (cv.width !== w * dpr || cv.height !== h * dpr) {
      cv.width = w * dpr; cv.height = h * dpr;
    }
    const ctx = cv.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const y = (counts: number) => h - (counts / adcMax) * h;

    // 0 V reference, wherever the DC offset puts it
    ctx.strokeStyle = "rgba(255,255,255,0.10)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, y(zeroCounts)); ctx.lineTo(w, y(zeroCounts)); ctx.stroke();

    if (!wave || wave.length === 0) return;
    const n = wave.length;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.25;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * w;
      let yy = y(wave[i]);
      if (yy < 0) yy = 0; else if (yy > h) yy = h;
      i === 0 ? ctx.moveTo(x, yy) : ctx.lineTo(x, yy);
    }
    ctx.stroke();
  }, [wave, zeroCounts, adcMax, height, color]);

  return (
    <div className="wave">
      <div className="wave-plot" style={{ height }}>
        <canvas ref={ref} style={{ width: "100%", height, display: "block" }} />
        <span className="ax y max">{fmtV(voltsAt(adcMax))}</span>
        <span className="ax y zero" style={{ top: `${(1 - zeroFrac) * 100}%` }}>0 V</span>
        <span className="ax y min">{fmtV(voltsAt(0))}</span>
      </div>
      <div className="wave-x">
        <span>0</span>
        <span>{windowNs ? fmtTime(windowNs) : ""}</span>
      </div>
    </div>
  );
}

/** Signed volts at the window edges, e.g. "+0.500 V". */
export function fmtV(v: number) {
  const s = Math.abs(v) < 5e-4 ? "0.000" : Math.abs(v).toFixed(3);
  return (v < 0 ? "-" : "+") + s + " V";
}

/** ns -> ps/ns/us/ms. The 742 spans 204.8 ns at 5 GS/s and 1.4 us at 750 MS/s,
 *  so the right unit genuinely changes with the sampling frequency. */
export function fmtTime(ns: number) {
  const pick = (v: number, u: string) =>
    (Number.isInteger(v) ? String(v) : v.toFixed(1)) + " " + u;
  if (ns < 1) return pick(ns * 1000, "ps");
  if (ns < 1000) return pick(ns, "ns");
  if (ns < 1e6) return pick(ns / 1000, "µs");
  return pick(ns / 1e6, "ms");
}
