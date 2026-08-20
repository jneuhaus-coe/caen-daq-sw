import { useEffect, useRef } from "react";
import { fmtV, voltsAtCount, zeroCounts } from "../volts";
import type { Geom } from "../volts";

interface Props {
  wave?: number[];
  /** uint16 DAC word; positions 0 V within the ADC window. */
  dcOffset: number;
  geom: Geom;
  windowNs?: number;  // full record length in ns, for the time axis
  height?: number;
  color: string;
}

/** One channel's averaged waveform on the FULL 0..adcMax window - never
 * autoscaled, so a railed or badly-offset channel is obvious at a glance.
 *
 * Axis labels are HTML rather than canvas text: crisper, and they stay put
 * without re-measuring on every repaint. */
export function MiniWave({ wave, dcOffset, geom, windowNs, height = 140, color }: Props) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const adcMax = geom.adc_max;
  const zc = zeroCounts(dcOffset, geom);
  const zeroFrac = Math.min(1, Math.max(0, zc / adcMax));

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
    ctx.moveTo(0, y(zc)); ctx.lineTo(w, y(zc)); ctx.stroke();

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
  }, [wave, zc, adcMax, height, color]);

  return (
    <div className="wave">
      <div className="wave-plot" style={{ height }}>
        <canvas ref={ref} style={{ width: "100%", height, display: "block" }} />
        <span className="ax y max">{fmtV(voltsAtCount(adcMax, dcOffset, geom))}</span>
        <span className="ax y zero" style={{ top: `${(1 - zeroFrac) * 100}%` }}>0 V</span>
        <span className="ax y min">{fmtV(voltsAtCount(0, dcOffset, geom))}</span>
      </div>
      <div className="wave-x">
        <span>0</span>
        <span>{windowNs ? fmtTime(windowNs) : ""}</span>
      </div>
    </div>
  );
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
