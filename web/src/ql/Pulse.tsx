import { useEffect, useRef, useState } from "react";
import type { Processing } from "./types";
import { fmt, niceTicks } from "./Chart";

/** The average pulse with the baseline and integration windows on it.
 *  Drag a window, or either of its edges; the change is applied when you
 *  let go, so a drag never starts a recompute per pixel. */
const W = 600, H = 190, ML = 40, MR = 10, MT = 22, MB = 26;

type Which = "base" | "win";
type Part = "lo" | "hi" | "body";

export function Pulse({ pulse, processing, onChange }: {
  pulse: { t: number[]; v: number[]; ref_t0?: number | null } | null;
  processing: Processing;
  onChange: (p: Processing) => void;
}) {
  const [draft, setDraft] = useState<Processing>(processing);
  const drag = useRef<{ which: Which; part: Part; start: number; orig: [number, number] } | null>(null);
  useEffect(() => { if (!drag.current) setDraft(processing); }, [processing]);

  if (!pulse || pulse.t.length < 2) {
    return <div className="ql-pulse-empty muted">The average pulse appears once the first events are read.</div>;
  }
  const t = pulse.t, v = pulse.v;
  const tmax = t[t.length - 1];
  const vmin = Math.min(...v), vmax = Math.max(...v);
  const pad = (vmax - vmin) * 0.08 || 1;
  const y0 = vmin - pad, y1 = vmax + pad;
  const sx = (x: number) => ML + (x / tmax) * (W - ML - MR);
  const sy = (y: number) => H - MB - (y - y0) / (y1 - y0) * (H - MT - MB);
  const toT = (px: number) => (px - ML) / (W - ML - MR) * tmax;
  const ref = draft.window.mode === "reference";
  const t0 = ref ? (pulse.ref_t0 ?? null) : 0;
  const base = draft.baseline;
  const win: [number, number] | null = t0 === null ? null
    : [draft.window.range[0] + t0, draft.window.range[1] + t0];
  const d = t.map((x, i) => `${i ? "L" : "M"}${sx(x).toFixed(1)} ${sy(v[i]).toFixed(1)}`).join("");

  const svgX = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return (e.clientX - r.left) * (W / r.width);
  };
  const start = (which: Which, part: Part) => (e: React.PointerEvent<SVGElement>) => {
    const svg = (e.currentTarget as SVGElement).ownerSVGElement ?? (e.currentTarget as SVGSVGElement);
    svg.setPointerCapture(e.pointerId);
    const r = svg.getBoundingClientRect();
    drag.current = { which, part, start: toT((e.clientX - r.left) * (W / r.width)),
                     orig: which === "base" ? [...draft.baseline] as [number, number]
                                            : [...draft.window.range] as [number, number] };
    e.stopPropagation();
  };
  const move = (e: React.PointerEvent<SVGSVGElement>) => {
    const g = drag.current;
    if (!g) return;
    const dt = Math.round((toT(svgX(e)) - g.start) * 2) / 2;
    let [a, b] = g.orig;
    if (g.part === "lo") a = Math.min(a + dt, b - 0.5);
    else if (g.part === "hi") b = Math.max(b + dt, a + 0.5);
    else { a += dt; b += dt; }
    setDraft((p) => g.which === "base" ? { ...p, baseline: [a, b] }
      : { ...p, window: { ...p.window, range: [a, b] } });
  };
  const end = () => {
    if (!drag.current) return;
    drag.current = null;
    onChange(draft);
  };

  const band = (which: Which, r: [number, number], fill: string, edge: string, label: string, labelFill: string) => (
    <g className="ql-band">
      <rect x={sx(r[0])} y={MT} width={Math.max(1, sx(r[1]) - sx(r[0]))} height={H - MT - MB}
        fill={fill} style={{ cursor: "grab" }} onPointerDown={start(which, "body")} />
      <text x={(sx(r[0]) + sx(r[1])) / 2} y={MT - 7} fill={labelFill} fontSize={11} textAnchor="middle">{label}</text>
      {(["lo", "hi"] as Part[]).map((p) => (
        <g key={p} onPointerDown={start(which, p)} style={{ cursor: "ew-resize" }}>
          <rect x={sx(p === "lo" ? r[0] : r[1]) - 5} y={MT} width={10} height={H - MT - MB} fill="transparent" />
          <path d={`M${sx(p === "lo" ? r[0] : r[1])} ${MT}V${H - MB}`} stroke={edge} strokeWidth={1.75} />
        </g>
      ))}
    </g>
  );

  return (
    <svg className="ql-pulse" viewBox={`0 0 ${W} ${H}`} role="img"
      aria-label="Average pulse with the baseline and integration windows; drag them to change"
      onPointerMove={move} onPointerUp={end} onPointerCancel={end}>
      <rect x={0} y={0} width={W} height={H} rx={8} fill="#10141a" />
      {band("base", base, "rgba(139,148,158,.16)", "#8b949e", "baseline", "#c9d1d9")}
      {win ? band("win", win, "rgba(31,111,235,.20)", "#58a6ff",
                  ref ? "integrate (from reference)" : "integrate", "#9ecbff") : null}
      {ref && t0 !== null ? <path d={`M${sx(t0)} ${MT}V${H - MB}`} stroke="#f0883e" strokeDasharray="3 3" /> : null}
      {sy(0) > MT && sy(0) < H - MB ? <path d={`M${ML} ${sy(0)}H${W - MR}`} stroke="#30363d" /> : null}
      <path d={d} fill="none" stroke="#e6edf3" strokeWidth={1.5} pointerEvents="none" />
      {niceTicks(0, tmax, 6).filter((x) => sx(x) < W - MR - 26).map((x) => (
        <text key={x} x={sx(x)} y={H - 8} fill="#8b949e" fontSize={10.5} textAnchor="middle"
          fontFamily="ui-monospace,monospace">{fmt(x)}</text>
      ))}
      <text x={W - MR} y={H - 8} fill="#8b949e" fontSize={10.5} textAnchor="end">ns</text>
      {niceTicks(y0, y1, 3).map((y) => (
        <text key={y} x={ML - 6} y={sy(y) + 4} fill="#8b949e" fontSize={10.5} textAnchor="end"
          fontFamily="ui-monospace,monospace">{fmt(y)}</text>
      ))}
      {ref && t0 === null ? <text x={W / 2} y={H / 2} fill="#f0883e" fontSize={12} textAnchor="middle">
        No pulse found on the reference channel</text> : null}
    </svg>
  );
}
