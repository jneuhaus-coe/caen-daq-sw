import { useEffect, useRef, useState } from "react";
import { DEFAULT_Y, fmtV, windowVolts } from "../volts";
import type { Geom } from "../volts";
import { WaveDensity } from "../waveDensity";
import { BlurInput } from "./BlurInput";

interface Props {
  wave?: number[];
  geom: Geom;
  windowNs?: number;      // full record length in ns
  postTriggerPct?: number;// how much of the record follows the trigger
  height?: number;
  color: string;
  /** Display range in window volts, [min, max]. Defaults to the full window. */
  yRange?: [number, number];
  /** min/max label edited. `range` null = reset to default; `all` = every channel. */
  onYRange?: (range: [number, number] | null, all: boolean) => void;
  /** "avg" draws the rolling mean; "overlay" stacks the last N single events
   *  into a density picture. */
  mode?: "avg" | "overlay";
  /** Latest single-event trace + its event id (overlay mode's feed). */
  lastWave?: number[];
  lastId?: number;
  /** Predicted baseline position in ADC counts for the current DC offset -
   *  the oscilloscope's ground marker. Drawn (dashed, in the channel colour)
   *  only while there is no data to show; real waveforms replace it. */
  baselineGuide?: number;
  /** Bumped by the app to wipe the persistence pile - on recording start and
   *  on calibration start, so a pile is always one coherent story. */
  clearEpoch?: number;
}

/** One channel's waveform in WINDOW-referenced volts: the ADC's fixed 1 Vpp
 * window is the frame, 0 V at its centre, and the DC offset moves the SIGNAL
 * within it - the same frame WaveDump and every oscilloscope use. Counts map
 * to fixed screen positions, so recorded history can never shift when a knob
 * moves; when an offset genuinely takes effect (at re-arm), the trace itself
 * moves. At the default full range the plot edges ARE the ADC rails.
 *
 * The min/max labels are buttons: click to type a new bound (optionally for
 * all channels), so zooming onto a pulse is two clicks, not a config file.
 * Axis labels are HTML rather than canvas text: crisper, and they stay put
 * without re-measuring on every repaint. */
export function MiniWave({
  wave, geom, windowNs, postTriggerPct, height = 140, color,
  yRange, onYRange, mode = "avg", lastWave, lastId, baselineGuide,
  clearEpoch,
}: Props) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const density = useRef(new WaveDensity());
  const offscreen = useRef<HTMLCanvasElement | null>(null);
  const [editing, setEditing] = useState<"min" | "max" | null>(null);
  const [editAll, setEditAll] = useState(false);
  const [yMin, yMax] = yRange ?? DEFAULT_Y;

  const frac = (v: number) => (yMax - v) / (yMax - yMin);   // 0 at top
  const zeroFrac = frac(0);

  // Wipe before any add on the same commit: declared first on purpose.
  useEffect(() => {
    density.current.clear();
  }, [clearEpoch]);

  // Feed the pile outside the paint effect - and in EVERY mode, so the
  // profile a calibration painted is already there when the operator flips
  // to Overlay to review it. A repaint (axis edit) must never re-add the
  // same event; the id makes adds exact.
  useEffect(() => {
    if (lastWave && lastId != null) {
      density.current.add(lastId, lastWave);
    }
  }, [lastWave, lastId]);

  // Post-trigger is the time AFTER the trigger, so the trigger sits that far
  // back from the right-hand edge.
  const trigFrac = postTriggerPct == null
    ? null : Math.min(1, Math.max(0, 1 - postTriggerPct / 100));
  const trigNs = trigFrac != null && windowNs != null ? windowNs * trigFrac : null;

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

    const y = (v: number) => frac(v) * h;
    const clampY = (v: number) => Math.min(h, Math.max(0, v));

    // Overlay mode: the density pile, under the reference lines so the
    // chrome stays legible on top of even the hottest paths.
    if (mode === "overlay" && density.current.count) {
      const gw = 256;
      const img = density.current.render(
        gw, h, (counts) => frac(windowVolts(counts, geom)) * h);
      let off = offscreen.current;
      if (!off || off.width !== gw || off.height !== h) {
        off = document.createElement("canvas");
        off.width = gw; off.height = h;
        offscreen.current = off;
      }
      off.getContext("2d")!.putImageData(img, 0, 0);
      ctx.drawImage(off, 0, 0, gw, h, 0, 0, w, h);
    }

    // Window centre, when it is on screen.
    if (zeroFrac >= 0 && zeroFrac <= 1) {
      ctx.strokeStyle = "rgba(255,255,255,0.10)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, y(0)); ctx.lineTo(w, y(0)); ctx.stroke();
    }

    // Trigger marker: accent, dashed and dimmed so it reads as chrome, not
    // data. Clamped inside the canvas: at post-trigger 0 the marker sits on
    // the very last sample.
    if (trigFrac != null) {
      const x = Math.min(w - 0.5, Math.max(0.5, Math.round(trigFrac * w) + 0.5));
      ctx.save();
      ctx.strokeStyle = "rgba(31,111,235,0.55)";
      ctx.setLineDash([4, 3]);
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke();
      ctx.restore();
    }

    // No data yet: the ground marker - where the current offset will put the
    // baseline (nominal model; the real trace is the truth once it arrives).
    const showingData = mode === "avg"
      ? !!wave && wave.length > 0
      : density.current.count > 0;
    if (!showingData && baselineGuide != null) {
      const gy = y(windowVolts(baselineGuide, geom));
      if (gy >= 0 && gy <= h) {
        ctx.save();
        ctx.strokeStyle = color;
        ctx.globalAlpha = 0.75;
        ctx.setLineDash([6, 4]);
        ctx.lineWidth = 1.25;
        ctx.beginPath();
        ctx.moveTo(0, gy); ctx.lineTo(w, gy); ctx.stroke();
        ctx.restore();
      }
    }

    if (mode !== "avg" || !wave || wave.length === 0) return;
    const n = wave.length;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.25;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const px = (i / (n - 1)) * w;
      const yy = clampY(y(windowVolts(wave[i], geom)));
      i === 0 ? ctx.moveTo(px, yy) : ctx.lineTo(px, yy);
    }
    ctx.stroke();
  }, [wave, yMin, yMax, height, color, trigFrac, geom, zeroFrac, mode, lastId,
      baselineGuide, clearEpoch]);

  const markStyle = trigFrac == null ? undefined : { left: `${trigFrac * 100}%` };

  const commitEdit = (which: "min" | "max", raw: string) => {
    setEditing(null);
    const v = Number(raw);
    if (!Number.isFinite(v) || !onYRange) return;
    const next: [number, number] = which === "min" ? [v, yMax] : [yMin, v];
    if (next[0] >= next[1]) return;        // an empty or inverted range is a typo
    onYRange(next, editAll);
  };

  const yLabel = (which: "min" | "max", value: number) =>
    editing === which ? (
      <span className={"ax y " + which + " yedit"}>
        <BlurInput
          type="number" step={0.01} autoFocus selectOnFocus
          value={value.toFixed(2)}
          onCommit={(v) => commitEdit(which, v)}
          onCancel={() => setEditing(null)}
        />
        <label title="Apply this range to every channel">
          <input type="checkbox" checked={editAll}
            onChange={(e) => setEditAll(e.target.checked)} />all
        </label>
        <button title="Reset to the full window"
          onMouseDown={(e) => { e.preventDefault(); setEditing(null); onYRange?.(null, editAll); }}>
          full
        </button>
      </span>
    ) : (
      <button className={"ax y " + which + " ybtn"} title="Click to set the display range"
        onClick={() => onYRange && setEditing(which)}>
        {fmtV(value)}
      </button>
    );

  return (
    <div className="wave">
      <div className="wave-plot" style={{ height }}>
        {yLabel("max", yMax)}
        {zeroFrac >= 0.06 && zeroFrac <= 0.94 ? (
          <span className="ax y zero" style={{ top: `${zeroFrac * 100}%` }}>0 V</span>
        ) : null}
        {yLabel("min", yMin)}
        <span className="ax x-total">{windowNs ? fmtTime(windowNs) : ""}</span>
        <div className="wave-canvas">
          <canvas ref={ref} style={{ width: "100%", height, display: "block" }} />
          {trigFrac != null ? (
            <span className="trig-tag" style={markStyle}>TRIG</span>
          ) : null}
        </div>
      </div>
      <div className="wave-x">
        {trigNs != null ? (
          <span className="trig-time" style={markStyle}>{fmtTime(trigNs)}</span>
        ) : null}
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
