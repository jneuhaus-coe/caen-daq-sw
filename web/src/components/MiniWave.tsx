import { useEffect, useRef } from "react";

interface Props {
  wave?: number[];
  baseline?: number;
  scale: number;      // shared half-amplitude (counts) mapped to half the height
  height?: number;
  color: string;
}

/** Cheap canvas sparkline for one channel's averaged waveform, drawn as
 * (sample - baseline) on a shared amplitude scale so gain differences are
 * visible across the grid at a glance. */
export function MiniWave({ wave, baseline = 0, scale, height = 72, color }: Props) {
  const ref = useRef<HTMLCanvasElement | null>(null);

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
    // zero (baseline) line
    ctx.strokeStyle = "rgba(255,255,255,0.08)";
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2); ctx.stroke();
    if (!wave || wave.length === 0 || scale <= 0) return;
    const n = wave.length;
    const yMid = h / 2;
    const yspan = (h / 2) * 0.92;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.25;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * w;
      let y = yMid - ((wave[i] - baseline) / scale) * yspan;
      if (y < 0) y = 0; else if (y > h) y = h;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.stroke();
  }, [wave, baseline, scale, height, color]);

  return <canvas ref={ref} style={{ width: "100%", height, display: "block" }} />;
}
