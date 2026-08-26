/** Persistence display: the last N single-event traces stacked into a 2D
 * density image, oscilloscope-persistence style. The server ships one
 * decimated single-event trace per telemetry tick (so the stream can never
 * throttle data-taking); this class rings the last N of them and rasterizes
 * the pile on demand. Traces are kept in raw ADC counts, so a change of
 * display range or DC offset just re-rasterizes - nothing is lost.
 */

/** How many traces the pile holds. At the 12 Hz telemetry rate this is a
 *  little over five seconds of persistence. */
export const PERSIST_TRACES = 64;

export class WaveDensity {
  private traces: { t: number[]; dac?: number }[] = [];
  private lastId: number | null = null;

  /** Add one trace, deduped by event id (a re-render must not re-add).
   *  `refDac` stamps the DC-offset DAC in force when it was captured, so a
   *  later offset change can shift the pile PREDICTIVELY - showing where
   *  history will sit after the change takes effect. */
  add(id: number, trace: number[], refDac?: number): void {
    if (id === this.lastId) return;
    this.lastId = id;
    this.traces.push({ t: trace, dac: refDac });
    if (this.traces.length > PERSIST_TRACES) this.traces.shift();
  }

  get count(): number {
    return this.traces.length;
  }

  clear(): void {
    this.traces = [];
    this.lastId = null;
  }

  /** Rasterize the pile into a W x H RGBA image. `toRow` maps an ADC-count
   *  value to a fractional row (0 = top); out-of-range rows are clamped to
   *  the edge, so railed traces pile up visibly at the border instead of
   *  vanishing. Density is shown on a sqrt scale - linear hides the rare
   *  paths entirely next to the common ones. */
  render(width: number, height: number,
         toRow: (counts: number) => number,
         countShift?: (refDac?: number) => number): ImageData {
    const grid = new Float32Array(width * height);
    const clamp = (r: number) => Math.min(height - 1, Math.max(0, Math.round(r)));

    for (const rec of this.traces) {
      const tr = rec.t;
      const n = tr.length;
      if (n < 2) continue;
      // Predictive shift: where this trace's era will sit under the CURRENT
      // offset - so tuning moves history to preview the future.
      const s = countShift ? countShift(rec.dac) : 0;
      for (let i = 0; i < n - 1; i++) {
        // Vertical span per column, connecting consecutive samples the way a
        // line stroke would.
        const x = Math.min(width - 1, Math.round((i / (n - 1)) * (width - 1)));
        const a = clamp(toRow(tr[i] + s));
        const b = clamp(toRow(tr[i + 1] + s));
        const lo = Math.min(a, b), hi = Math.max(a, b);
        for (let y = lo; y <= hi; y++) grid[y * width + x] += 1;
      }
    }

    let max = 0;
    for (let i = 0; i < grid.length; i++) if (grid[i] > max) max = grid[i];
    const img = new ImageData(width, height);
    if (max === 0) return img;

    for (let i = 0; i < grid.length; i++) {
      const v = grid[i];
      if (v === 0) continue;
      const t = Math.sqrt(v / max);        // 0..1, rare paths still visible
      const p = i * 4;
      // Cold-to-hot ramp: dim blue -> cyan -> yellow -> white.
      img.data[p] = Math.round(255 * Math.min(1, Math.max(0, t * 2.2 - 0.9)));
      img.data[p + 1] = Math.round(255 * Math.min(1, t * 1.6));
      img.data[p + 2] = Math.round(255 * Math.min(1, 0.45 + t * 0.9 - Math.max(0, t * 1.8 - 0.9)));
      img.data[p + 3] = Math.round(255 * (0.35 + 0.65 * t));
    }
    return img;
  }
}
