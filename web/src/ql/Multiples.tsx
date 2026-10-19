import { useEffect, useRef, useState } from "react";
import type { ProcPrefs } from "./model";
import { download, fmt, niceTicks } from "./Chart";

/** Average pulses as small multiples: one panel per channel, every panel on
 *  the same scale so channels compare at a glance and nothing rescales as
 *  you look from one to the next. A cursor follows the pointer across all
 *  panels at once; any panel enlarges to full width.
 *
 *  With `edit`, the baseline and integration windows are drawn on every
 *  panel and can be dragged on any of them - the windows are one setting
 *  for the whole folder. The change is applied when you let go, so a drag
 *  never starts a recompute per pixel. */

export interface Line { name: string; color: string; t: number[]; v: number[] }
/** `excluded`: shown, but masked - a struck channel stays in view. */
export interface Panel { ch: number; title: string; sub?: string; excluded?: boolean; lines: Line[] }

/** Where a reference-placed window sat for one series (median over its
 *  events), drawn in the series' colour. Unused for a fixed window. */
export interface WindowRef { t0: number | null; color: string }

export interface WindowEdit {
  proc: ProcPrefs;
  refs: WindowRef[];
  onCommit: (p: ProcPrefs) => void;
}

type Which = "base" | "win";
type Part = "lo" | "hi" | "body";

const GRID = { W: 320, H: 168 };
const BIG = { W: 880, H: 320 };
const ML = 44, MR = 10, MT = 20, MB = 22;
const C = { surface: "#10141a", grid: "#21262d", axis: "#30363d", text: "#8b949e", trace: "#e6edf3" };
const WIN = "#58a6ff";       // a window that is the same for every series

export function Multiples({ panels, yMode, yLabel, edit, empty }: {
  panels: Panel[];
  /** "shared": one absolute y range for all. "offset": one mV span for all,
   *  each panel centred on its own trace (raw pulses sit at different
   *  pedestals, and a shared absolute range would flatten them). */
  yMode: "shared" | "offset";
  yLabel: string;
  edit?: WindowEdit;
  empty: string;
}) {
  const [focus, setFocus] = useState<number | null>(null);
  const [cursor, setCursor] = useState<{ ch: number; t: number } | null>(null);
  const [draft, setDraft] = useState<ProcPrefs | null>(edit?.proc ?? null);
  const dragging = useRef(false);
  useEffect(() => { if (!dragging.current) setDraft(edit?.proc ?? null); }, [edit?.proc]);

  const shown = focus !== null && panels.some((p) => p.ch === focus)
    ? panels.filter((p) => p.ch === focus) : panels;
  const big = shown.length === 1;
  useEffect(() => { if (focus !== null && !panels.some((p) => p.ch === focus)) setFocus(null); }, [focus, panels]);

  const lines = panels.flatMap((p) => p.lines);
  if (!lines.some((l) => l.t.length > 1)) {
    return <div className="ql-chart-empty muted">{empty}</div>;
  }

  // One time axis and one vertical scale for every panel.
  let t0 = Infinity, t1 = -Infinity;
  for (const l of lines) if (l.t.length) { t0 = Math.min(t0, l.t[0]); t1 = Math.max(t1, l.t[l.t.length - 1]); }
  const ext = (ls: Line[]) => {
    let lo = Infinity, hi = -Infinity;
    for (const l of ls) for (const v of l.v) { if (v < lo) lo = v; if (v > hi) hi = v; }
    return [lo, hi] as const;
  };
  const yRange = (p: Panel): [number, number] => {
    if (yMode === "shared") {
      let [lo, hi] = ext(lines);
      lo = Math.min(lo, 0); hi = Math.max(hi, 0);
      const pad = (hi - lo) * 0.06 || 1;
      return [lo - pad, hi + pad];
    }
    const span = Math.max(1, ...panels.map((q) => { const [a, b] = ext(q.lines); return isFinite(b - a) ? b - a : 0; })) * 1.12;
    const [a, b] = ext(p.lines);
    const mid = isFinite(a + b) ? (a + b) / 2 : 0;
    return [mid - span / 2, mid + span / 2];
  };

  const step = (d: number) => {
    const i = panels.findIndex((p) => p.ch === focus);
    if (i >= 0) setFocus(panels[(i + d + panels.length) % panels.length].ch);
  };

  return (
    <div className="ql-multiples"
      onKeyDown={(e) => {
        if (focus === null) return;
        if (e.key === "Escape") { e.stopPropagation(); setFocus(null); }
        else if (e.key === "ArrowLeft" && !(e.target instanceof HTMLSelectElement)) step(-1);
        else if (e.key === "ArrowRight" && !(e.target instanceof HTMLSelectElement)) step(1);
      }}>
      {focus !== null && big && panels.length > 1 ? (
        <div className="ql-focusbar">
          <button className="mini" onClick={() => setFocus(null)}>All channels</button>
          <span className="ql-grow" />
          <button className="mini" aria-label="Previous channel" onClick={() => step(-1)}>‹</button>
          <button className="mini" aria-label="Next channel" onClick={() => step(1)}>›</button>
        </div>
      ) : null}
      <div className={"ql-panels" + (big ? " big" : "")}>
        {shown.map((p) => (
          <PanelView key={p.ch} panel={p} size={big ? BIG : GRID} x={[t0, t1]} y={yRange(p)}
            yLabel={big ? yLabel : undefined}
            cursor={cursor} setCursor={setCursor}
            draft={edit ? draft : null} refs={edit?.refs ?? []}
            onDraft={(d) => { dragging.current = true; setDraft(d); }}
            onCommit={(d) => { dragging.current = false; edit?.onCommit(d); }}
            onEnlarge={panels.length > 1 && !big ? () => setFocus(p.ch) : undefined} />
        ))}
      </div>
    </div>
  );
}

function PanelView({ panel, size, x, y, yLabel, cursor, setCursor, draft, refs, onDraft, onCommit, onEnlarge }: {
  panel: Panel;
  size: { W: number; H: number };
  x: [number, number];
  y: [number, number];
  yLabel?: string;
  cursor: { ch: number; t: number } | null;
  setCursor: (c: { ch: number; t: number } | null) => void;
  draft: ProcPrefs | null;
  refs: WindowRef[];
  onDraft: (p: ProcPrefs) => void;
  onCommit: (p: ProcPrefs) => void;
  onEnlarge?: () => void;
}) {
  const { W, H } = size;
  const ml = yLabel ? ML + 16 : ML;
  const drag = useRef<{ which: Which; part: Part; start: number; orig: [number, number]; last: ProcPrefs } | null>(null);
  const sx = (t: number) => ml + (t - x[0]) / (x[1] - x[0] || 1) * (W - ml - MR);
  const sy = (v: number) => H - MB - (v - y[0]) / (y[1] - y[0] || 1) * (H - MT - MB);
  const toT = (px: number) => x[0] + (px - ml) / (W - ml - MR) * (x[1] - x[0]);
  const svgX = (e: React.PointerEvent) => {
    const r = (e.currentTarget as Element).closest("svg")!.getBoundingClientRect();
    return (e.clientX - r.left) * (W / r.width);
  };

  const editing = !!draft;
  const showBase = editing && draft!.baselineOn;
  const mode = draft?.window.mode;
  // One integration window for a fixed window; one per series placed from
  // a reference, since each series' pulses can start somewhere else.
  const wins: { r: [number, number]; color: string; t0: number | null }[] = !editing || mode === "all" ? []
    : mode === "reference"
      ? refs.filter((f) => f.t0 !== null).map((f) => ({
          r: [draft!.window.range[0] + f.t0!, draft!.window.range[1] + f.t0!], color: f.color, t0: f.t0 }))
      : [{ r: draft!.window.range, color: WIN, t0: null }];

  const start = (which: Which, part: Part) => (e: React.PointerEvent<SVGElement>) => {
    if (!draft) return;
    const svg = (e.currentTarget as SVGElement).ownerSVGElement!;
    svg.setPointerCapture(e.pointerId);
    drag.current = { which, part, start: toT(svgX(e)), last: draft,
                     orig: which === "base" ? [...draft.baseline] as [number, number]
                                            : [...draft.window.range] as [number, number] };
    setCursor(null);
    e.stopPropagation();
  };
  const move = (e: React.PointerEvent<SVGSVGElement>) => {
    const g = drag.current;
    if (!g) {
      setCursor({ ch: panel.ch, t: toT(svgX(e)) });
      return;
    }
    const dt = Math.round((toT(svgX(e)) - g.start) * 2) / 2;
    let [a, b] = g.orig;
    if (g.part === "lo") a = Math.min(a + dt, b - 0.5);
    else if (g.part === "hi") b = Math.max(b + dt, a + 0.5);
    else { a += dt; b += dt; }
    const d = g.which === "base" ? { ...g.last, baseline: [a, b] as [number, number] }
      : { ...g.last, window: { ...g.last.window, range: [a, b] as [number, number] } };
    onDraft(d);
  };
  const end = () => {
    const g = drag.current;
    if (!g || !draft) return;
    drag.current = null;
    onCommit(draft);
  };

  const band = (which: Which, r: [number, number], fill: string, fillOpacity: number, edge: string,
                label: string, labelFill: string, key?: number) => (
    <g key={key} className="ql-band">
      <rect x={sx(r[0])} y={MT} width={Math.max(1, sx(r[1]) - sx(r[0]))} height={H - MT - MB}
        fill={fill} fillOpacity={fillOpacity} style={{ cursor: "grab" }} onPointerDown={start(which, "body")} />
      {W >= BIG.W ? <text x={(sx(r[0]) + sx(r[1])) / 2} y={MT - 6} fill={labelFill} fontSize={11}
        textAnchor="middle">{label}</text> : null}
      {(["lo", "hi"] as Part[]).map((p) => (
        <g key={p} onPointerDown={start(which, p)} style={{ cursor: "ew-resize" }}>
          <rect x={sx(p === "lo" ? r[0] : r[1]) - 5} y={MT} width={10} height={H - MT - MB} fill="transparent" />
          <path d={`M${sx(p === "lo" ? r[0] : r[1])} ${MT}V${H - MB}`} stroke={edge} strokeWidth={1.5} />
        </g>
      ))}
    </g>
  );

  const at = cursor && cursor.t >= x[0] && cursor.t <= x[1] ? cursor.t : null;
  const mine = cursor?.ch === panel.ch && at !== null;
  const fs = W >= BIG.W ? 11 : 10;
  const clip = `ql-clip-${panel.ch}-${W}`;

  return (
    <div className="ql-panel">
      <svg className="ql-panel-svg" viewBox={`0 0 ${W} ${H}`} xmlns="http://www.w3.org/2000/svg"
        role="img" aria-label={`Average pulse, ${panel.title}`}
        onPointerMove={move} onPointerUp={end} onPointerCancel={end}
        onPointerLeave={() => { if (!drag.current) setCursor(null); }}>
        <defs><clipPath id={clip}><rect x={ml} y={MT} width={W - ml - MR} height={H - MT - MB} /></clipPath></defs>
        <rect x={0} y={0} width={W} height={H} rx={6} fill={C.surface} />
        {niceTicks(y[0], y[1], W >= BIG.W ? 5 : 3).map((v) => (
          <g key={v}>
            <path d={`M${ml} ${sy(v)}H${W - MR}`} stroke={v === 0 ? C.axis : C.grid} />
            <text x={ml - 5} y={sy(v) + 3.5} fill={C.text} fontSize={fs} textAnchor="end"
              fontFamily="ui-monospace,monospace">{fmt(v)}</text>
          </g>
        ))}
        {niceTicks(x[0], x[1], W >= BIG.W ? 8 : 4).filter((t) => sx(t) < W - MR - 14).map((t) => (
          <text key={t} x={sx(t)} y={H - 7} fill={C.text} fontSize={fs} textAnchor="middle"
            fontFamily="ui-monospace,monospace">{fmt(t)}</text>
        ))}
        <text x={W - MR} y={H - 7} fill={C.text} fontSize={fs} textAnchor="end">ns</text>
        {yLabel ? <text x={13} y={(MT + H - MB) / 2} fill={C.text} fontSize={11.5} textAnchor="middle"
          transform={`rotate(-90 13 ${(MT + H - MB) / 2})`}>{yLabel}</text> : null}
        <text x={ml} y={MT - 6} fill="#c9d1d9" fontSize={W >= BIG.W ? 12.5 : 11.5} fontWeight={600}>
          {panel.title}{panel.sub ? <tspan fill="#9ecbff" fontWeight={400}>  {panel.sub}</tspan> : null}
        </text>
        <g clipPath={`url(#${clip})`}>
          {showBase ? band("base", draft!.baseline, "#8b949e", 0.16, "#8b949e", "baseline", "#c9d1d9") : null}
          {wins.map((w, i) => band("win", w.r, w.color, wins.length > 1 ? 0.12 : 0.2, w.color,
            i ? "" : mode === "reference" ? "integrate (from reference)" : "integrate", "#9ecbff", i))}
          {wins.filter((w) => w.t0 !== null).map((w, i) => (
            <path key={i} d={`M${sx(w.t0!)} ${MT}V${H - MB}`} stroke={w.color} strokeDasharray="3 3" pointerEvents="none" />
          ))}
          {panel.lines.map((l, i) => (
            <path key={i} pointerEvents="none" fill="none" stroke={l.color} strokeWidth={1.4}
              d={l.t.map((t, k) => `${k ? "L" : "M"}${sx(t).toFixed(1)} ${sy(l.v[k]).toFixed(1)}`).join("")} />
          ))}
          {at !== null ? <path d={`M${sx(at)} ${MT}V${H - MB}`} stroke={C.text} strokeDasharray="3 3" pointerEvents="none" /> : null}
        </g>
        {panel.excluded ? (
          // Masks the plot and catches the pointer: nothing to drag here.
          <g>
            <rect x={ml} y={MT} width={W - ml - MR} height={H - MT - MB} fill={C.surface} opacity={0.72} />
            <text x={(ml + W - MR) / 2} y={(MT + H - MB) / 2 + 4} fill="#c9d1d9" fontSize={W >= BIG.W ? 13 : 11.5}
              textAnchor="middle" letterSpacing={0.5}>excluded</text>
          </g>
        ) : null}
        {!panel.excluded && !panel.lines.some((l) => l.t.length > 1) ? (
          <text x={(ml + W - MR) / 2} y={(MT + H - MB) / 2} fill={C.text} fontSize={11} textAnchor="middle">no events</text>
        ) : null}
      </svg>
      {onEnlarge ? (
        <button className="ql-enlarge" aria-label={`Enlarge ${panel.title}`} title="Enlarge" onClick={onEnlarge}>
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4" aria-hidden="true">
            <path d="M7 1h4v4M5 11H1V7M11 1L7 5M1 11l4-4" />
          </svg>
        </button>
      ) : null}
      {mine ? (
        <div className="ql-tip ql-panel-tip" style={{ left: `${Math.min(sx(at!) / W * 100, 62)}%` }}>
          <span className="mono">{fmt(at!)} ns</span>
          {panel.lines.map((l, i) => (
            <span key={i} className="mono">
              {panel.lines.length > 1 ? <span className="ql-sw" style={{ background: l.color }} /> : null}
              {fmt(valueAt(l, at!))} mV{panel.lines.length > 1 ? <span className="muted"> {l.name}</span> : null}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function valueAt(l: Line, t: number): number {
  let lo = 0, hi = l.t.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (l.t[m] < t) lo = m; else hi = m; }
  return Math.abs(l.t[lo] - t) <= Math.abs(l.t[hi] - t) ? l.v[lo] : l.v[hi];
}

/** Download every panel in `host` as one PNG at 2x, laid out as on screen. */
export async function exportPanelsPng(host: HTMLElement, filename: string) {
  const box = host.getBoundingClientRect();
  const c = document.createElement("canvas");
  c.width = Math.round(box.width * 2); c.height = Math.round(box.height * 2);
  const g = c.getContext("2d")!;
  g.scale(2, 2);
  g.fillStyle = "#161b22";
  g.fillRect(0, 0, box.width, box.height);
  for (const svg of host.querySelectorAll<SVGSVGElement>("svg.ql-panel-svg")) {
    const r = svg.getBoundingClientRect();
    const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(svg)], { type: "image/svg+xml" }));
    try {
      const img = new Image();
      await new Promise<void>((res, rej) => { img.onload = () => res(); img.onerror = () => rej(); img.src = url; });
      g.drawImage(img, r.left - box.left, r.top - box.top, r.width, r.height);
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  const blob: Blob = await new Promise((res) => c.toBlob((b) => res(b!), "image/png"));
  download(blob, filename);
}
