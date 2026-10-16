import { forwardRef, useMemo, useRef, useState, type ReactNode } from "react";

/** One SVG chart for every Quick Look plot: points with error bars, lines,
 *  step histograms, fit curves. Fixed viewBox, scaled to the card's width;
 *  colours are attributes (not CSS) so an exported PNG looks the same. */

export interface ChartPoint { x: number; y: number; err?: number | null; tip?: ReactNode }
export interface ChartSeries {
  name: string;
  color: string;
  points: ChartPoint[];
  line?: boolean;           // join the points
  markers?: boolean;
  step?: boolean;           // histogram: points are bin centres, drawn as steps
  fit?: [number, number][];
}
export interface Tick { value: number; label: string; sub?: string; dim?: boolean }

interface Props {
  series: ChartSeries[];
  xLabel: string;
  yLabel: string;
  xTicks?: Tick[];          // categorical axis (channels); else numeric
  bands?: { x0: number; x1: number; label: string }[];
  dodge?: boolean;          // spread series sideways at shared x (channels)
  zeroY?: boolean;
  empty?: string;
}

export const W = 880, H = 340;
const ML = 62, MR = 16, MT = 16, MB = 48;
const C = { surface: "#10141a", grid: "#21262d", axis: "#30363d", text: "#8b949e" };

export function niceTicks(lo: number, hi: number, n = 5): number[] {
  if (!isFinite(lo) || !isFinite(hi)) return [];
  if (hi <= lo) { hi = lo + 1; }
  const raw = (hi - lo) / n;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) {
    out.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  }
  return out;
}

export function fmt(v: number | null | undefined, digits = 3): string {
  if (v === null || v === undefined || !isFinite(v)) return "-";
  const a = Math.abs(v);
  if (a !== 0 && (a >= 1e5 || a < 1e-3)) return v.toExponential(2);
  return Number(v.toPrecision(digits)).toString();
}

export const Chart = forwardRef<SVGSVGElement, Props>(function Chart(
  { series, xLabel, yLabel, xTicks, bands, dodge, zeroY, empty }, ref) {
  const wrap = useRef<HTMLDivElement | null>(null);
  const [hover, setHover] = useState<{ vx: number; px: number; py: number; s: number; i: number } | null>(null);

  const geo = useMemo(() => {
    const xs: number[] = [], ys: number[] = [];
    for (const s of series) {
      for (const p of s.points) {
        if (!isFinite(p.x) || !isFinite(p.y)) continue;
        xs.push(p.x);
        ys.push(p.y - (p.err ?? 0), p.y + (p.err ?? 0));
      }
      for (const [x, y] of s.fit ?? []) { xs.push(x); ys.push(y); }
    }
    if (xTicks?.length) xs.push(...xTicks.map((t) => t.value));
    if (!xs.length || !ys.length) return null;
    let x0 = Math.min(...xs), x1 = Math.max(...xs);
    if (xTicks?.length) { x0 -= 0.5; x1 += 0.5; }
    else if (x1 === x0) { x0 -= 1; x1 += 1; }
    else { const pad = (x1 - x0) * 0.04; x0 -= pad; x1 += pad; }
    let y0 = Math.min(...ys), y1 = Math.max(...ys);
    if (zeroY && y0 > 0) y0 = 0;
    if (y1 === y0) { y0 -= 1; y1 += 1; }
    const pad = (y1 - y0) * 0.06;
    y1 += pad; if (!(zeroY && y0 === 0)) y0 -= pad;
    const sx = (x: number) => ML + (x - x0) / (x1 - x0) * (W - ML - MR);
    const sy = (y: number) => H - MB - (y - y0) / (y1 - y0) * (H - MT - MB);
    return { x0, x1, y0, y1, sx, sy };
  }, [series, xTicks, zeroY]);

  if (!geo) {
    return <div className="ql-chart-empty muted">{empty ?? "Nothing to plot yet."}</div>;
  }
  const { sx, sy, x0, x1, y0, y1 } = geo;
  const yt = niceTicks(y0, y1, 5);
  const xt: Tick[] = xTicks ?? niceTicks(x0, x1, 8).map((v) => ({ value: v, label: fmt(v) }));
  const nS = series.length;
  const off = (si: number) => dodge && nS > 1 ? (si - (nS - 1) / 2) * Math.min(4, 30 / nS) : 0;

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const svg = e.currentTarget;
    const r = svg.getBoundingClientRect();
    const k = W / r.width;
    const mx = (e.clientX - r.left) * k, my = (e.clientY - r.top) * k;
    let best: { d: number; s: number; i: number; px: number; py: number } | null = null;
    series.forEach((s, si) => s.points.forEach((p, i) => {
      if (!isFinite(p.x) || !isFinite(p.y)) return;
      const px = sx(p.x) + off(si), py = sy(p.y);
      const d = s.step ? Math.abs(px - mx) + Math.abs(py - my) * 0.2 : Math.hypot(px - mx, py - my);
      if (!best || d < best.d) best = { d, s: si, i, px, py };
    }));
    const b = best as { d: number; s: number; i: number; px: number; py: number } | null;
    setHover(b && b.d < 40 ? { vx: b.px, px: b.px / k, py: b.py / k, s: b.s, i: b.i } : null);
  };

  const hp = hover ? series[hover.s]?.points[hover.i] : null;
  return (
    <div className="ql-chart" ref={wrap}>
      <svg ref={ref} viewBox={`0 0 ${W} ${H}`} xmlns="http://www.w3.org/2000/svg"
        role="img" aria-label={`${yLabel} versus ${xLabel}`}
        onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
        <rect x={0} y={0} width={W} height={H} rx={8} fill={C.surface} />
        {(bands ?? []).map((b, i) => (
          <g key={i}>
            <rect x={sx(b.x0)} y={MT} width={sx(b.x1) - sx(b.x0)} height={H - MT - MB}
              fill={C.grid} opacity={0.6} />
            <text x={(sx(b.x0) + sx(b.x1)) / 2} y={MT + 12} fill={C.text} fontSize={10.5}
              textAnchor="middle">{b.label}</text>
          </g>
        ))}
        {yt.map((v) => (
          <g key={v}>
            <path d={`M${ML} ${sy(v)}H${W - MR}`} stroke={C.grid} />
            <text x={ML - 8} y={sy(v) + 4} fill={C.text} fontSize={11} textAnchor="end"
              fontFamily="ui-monospace,monospace">{fmt(v)}</text>
          </g>
        ))}
        <path d={`M${ML} ${H - MB}H${W - MR}`} stroke={C.axis} />
        {xt.map((t) => (
          <g key={t.value}>
            <text x={sx(t.value)} y={H - MB + 16} fill={t.dim ? "#484f58" : C.text} fontSize={11}
              textAnchor="middle" fontFamily="ui-monospace,monospace">{t.label}</text>
            {t.sub ? <text x={sx(t.value)} y={H - MB + 28} fill="#9ecbff" fontSize={9.5}
              textAnchor="middle" fontFamily="ui-monospace,monospace">{t.sub}</text> : null}
          </g>
        ))}
        <text x={(ML + W - MR) / 2} y={H - 6} fill={C.text} fontSize={11.5} textAnchor="middle">{xLabel}</text>
        <text x={14} y={(MT + H - MB) / 2} fill={C.text} fontSize={11.5} textAnchor="middle"
          transform={`rotate(-90 14 ${(MT + H - MB) / 2})`}>{yLabel}</text>
        {series.map((s, si) => {
          const pts = s.points.filter((p) => isFinite(p.x) && isFinite(p.y));
          const o = off(si);
          let line = "";
          if (s.step && pts.length > 1) {
            const half = (pts[1].x - pts[0].x) / 2;
            pts.forEach((p, i) => {
              const a = sx(p.x - half), b = sx(p.x + half), y = sy(p.y);
              line += (i ? "L" : "M") + `${a.toFixed(1)} ${y.toFixed(1)}H${b.toFixed(1)}`;
            });
          } else if (s.line) {
            // Break the line where a point is missing (a struck channel).
            let pen = false;
            for (const p of s.points) {
              if (!isFinite(p.x) || !isFinite(p.y)) { pen = false; continue; }
              line += (pen ? "L" : "M") + `${(sx(p.x) + o).toFixed(1)} ${sy(p.y).toFixed(1)}`;
              pen = true;
            }
          }
          const errs = pts.filter((p) => p.err).map((p) =>
            `M${(sx(p.x) + o).toFixed(1)} ${sy(p.y + p.err!).toFixed(1)}V${sy(p.y - p.err!).toFixed(1)}`).join("");
          const fit = (s.fit ?? []).map(([x, y], i) => `${i ? "L" : "M"}${sx(x).toFixed(1)} ${sy(y).toFixed(1)}`).join("");
          return (
            <g key={si}>
              {fit ? <path d={fit} fill="none" stroke={s.color} strokeWidth={1.5} strokeDasharray="5 4" opacity={0.8} /> : null}
              {line ? <path d={line} fill="none" stroke={s.color} strokeWidth={s.step ? 1.75 : 1.5}
                opacity={s.markers === false ? 1 : 0.55} /> : null}
              {errs ? <path d={errs} fill="none" stroke={s.color} strokeWidth={1.5} /> : null}
              {s.markers !== false && !s.step ? pts.map((p, i) => (
                <circle key={i} cx={sx(p.x) + o} cy={sy(p.y)} r={3.6} fill={s.color}
                  stroke={C.surface} strokeWidth={1.5} />
              )) : null}
            </g>
          );
        })}
        {hover ? <path d={`M${hover.vx} ${MT}V${H - MB}`}
          stroke={C.text} strokeDasharray="3 3" /> : null}
      </svg>
      {hover && hp ? (
        <div className="ql-tip" style={{
          left: Math.min(hover.px + 12, (wrap.current?.clientWidth ?? 600) - 220), top: Math.max(4, hover.py - 20),
        }}>
          <b><span className="ql-sw" style={{ background: series[hover.s].color }} />{series[hover.s].name}</b>
          {hp.tip ?? <span className="mono">{fmt(hp.x)} , {fmt(hp.y)}{hp.err ? ` ± ${fmt(hp.err, 2)}` : ""}</span>}
        </div>
      ) : null}
    </div>
  );
});

/** Download an SVG chart as a PNG at 2x, background included. */
export async function exportPng(svg: SVGSVGElement, filename: string) {
  const xml = new XMLSerializer().serializeToString(svg);
  const img = new Image();
  const url = URL.createObjectURL(new Blob([xml], { type: "image/svg+xml" }));
  try {
    await new Promise<void>((res, rej) => { img.onload = () => res(); img.onerror = () => rej(); img.src = url; });
    const c = document.createElement("canvas");
    c.width = W * 2; c.height = H * 2;
    const g = c.getContext("2d")!;
    g.scale(2, 2);
    g.drawImage(img, 0, 0, W, H);
    const blob: Blob = await new Promise((res) => c.toBlob((b) => res(b!), "image/png"));
    download(blob, filename);
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function download(blob: Blob, filename: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
