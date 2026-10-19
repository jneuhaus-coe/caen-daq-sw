/** Quick Look's client-side model: facets, the per-folder settings, and how
 *  runs become plot groups. Facets live here, not on the server - they are
 *  this view's reading of the folder, and Quick Look never writes data.
 *
 *  A facet is a named value per run (energy = 8, particle = e) used to
 *  filter runs and to split them into series. They come from the
 *  Experiment Conditions, or are read out of the run notes / folder names. */
import type { ChanSel, ChannelSetting, Cut, Err, Kind, Processing, Quantity, QlRun, Stat } from "./types";

export const N_CH = 16;

/** A facet read out of each run's note (or its run folder name) with a
 *  pattern. Facets from the Experiment Conditions need no definition:
 *  every key in the metadata is one automatically. */
export interface FacetDef {
  name: string;
  source: "note" | "folder";
  pattern: string;          // regex; the first capture group is the value
  kind: "number" | "text";
}

export interface Filter { facet: string; value: string }

export interface PlotSpec {
  recipe: Recipe;
  quantity: Quantity;
  stat: Stat;
  err: Err;
  channel: ChanSel;
  seriesFacets: string[];   // [] = one series; several = one per combination
  xFacet: string;           // vs Facet / Resolution
  filters: Filter[];
  fit: boolean;
  waveHidden: number[];     // channels left out of the Waveforms plot
  hiddenWindows: string[];  // series whose reference-placed window is not drawn
}

export type Recipe = "waveform" | "hist" | "channel" | "facet" | "resolution" | "spatial";

export const RECIPES: { id: Recipe; label: string; kind: Kind; help: string }[] = [
  { id: "waveform", label: "Waveforms", kind: "waveform", help: "Average pulse of every channel, one line per group" },
  { id: "hist", label: "Distribution", kind: "hist", help: "Histogram of a value on one channel (or the charge sum)" },
  { id: "channel", label: "vs Channel", kind: "channel", help: "A statistic of a value on every channel" },
  { id: "facet", label: "vs Facet", kind: "facet", help: "A statistic against any facet, e.g. linearity vs energy, or response per plate" },
  { id: "resolution", label: "Resolution", kind: "facet", help: "sigma/mean against a numeric facet, with a stochastic/constant/noise fit" },
  { id: "spatial", label: "Spatial", kind: "spatial", help: "Share of charge per pixel and the shower centroid" },
];

/** The processing steps as the panel keeps them. Baseline subtraction can
 *  be off; the window it would use is kept for when it comes back. */
export interface ProcPrefs {
  baselineOn: boolean;
  baseline: [number, number];
  window: { mode: "record" | "reference" | "all"; range: [number, number]; reference: string | null };
  cfd: number;
}

export interface FolderPrefs {
  facets: FacetDef[];
  overrides: Record<string, Record<string, string>>;   // run key -> facet -> value
  channels: ChannelSetting[];
  deselected: string[];
  columns: string[] | null;  // facet columns in the runs table; null = pick for me
  processing: ProcPrefs;
  cuts: Cut[];
  noClip: boolean;
  pixels: number[];
  pitch: number;
  plot: PlotSpec;
}

export const DEFAULT_PROCESSING: ProcPrefs = {
  baselineOn: true,
  baseline: [10, 40],
  window: { mode: "record", range: [60, 120], reference: null },
  cfd: 0.3,
};

export function defaultChannels(): ChannelSetting[] {
  return Array.from({ length: N_CH }, (_, i) => ({ source: `in:${i}`, struck: false }));
}

export function defaultPrefs(): FolderPrefs {
  return {
    facets: [], overrides: {},
    channels: defaultChannels(),
    deselected: [], columns: null,
    processing: DEFAULT_PROCESSING,
    cuts: [], noClip: true,
    pixels: Array.from({ length: N_CH }, (_, i) => i), pitch: 3,
    plot: {
      recipe: "channel", quantity: "charge", stat: "mean", err: "rms",
      channel: "sum", seriesFacets: [], xFacet: "", filters: [], fit: true, waveHidden: [], hiddenWindows: [],
    },
  };
}

/** Processing as the server takes it: no baseline is null. */
export function wireProcessing(p: ProcPrefs): Processing {
  return { baseline: p.baselineOn ? p.baseline : null, window: p.window, cfd: p.cfd };
}

/** Prefs from storage or an imported file: anything malformed falls back
 *  to the default for that field instead of reaching the controls. Settings
 *  saved before facets were called facets (tags, seriesTag, xTag) still load. */
export function sanitize(raw: unknown): FolderPrefs {
  const d = defaultPrefs();
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, any>;
  const arr = (v: unknown) => (Array.isArray(v) ? v : null);
  const num = (v: unknown, f: number) => (typeof v === "number" && isFinite(v) ? v : f);
  const pair = (v: unknown, f: [number, number]): [number, number] => {
    const a = arr(v);
    return a && a.length === 2 ? [num(a[0], f[0]), num(a[1], f[1])] : f;
  };
  const chList = (v: unknown) => (arr(v) ?? []).filter((x: any) => Number.isInteger(x) && x >= 0 && x < N_CH);
  const facets = (arr(r.facets) ?? arr(r.tags) ?? []).filter((t: any) => t && typeof t.name === "string"
    && typeof t.pattern === "string").map((t: any): FacetDef => ({
      name: t.name, pattern: t.pattern,
      source: t.source === "folder" ? "folder" : "note",
      kind: t.kind === "text" ? "text" : "number",
    }));
  const chans = arr(r.channels);
  const p = (r.processing ?? {}) as Record<string, any>;
  const w = (p.window ?? {}) as Record<string, any>;
  const pl = (r.plot ?? {}) as Record<string, any>;
  const recipeId = pl.recipe === "tag" ? "facet" : pl.recipe;
  const recipe = RECIPES.some((x) => x.id === recipeId) ? recipeId : d.plot.recipe;
  const series = arr(pl.seriesFacets) ?? (typeof pl.seriesTag === "string" && pl.seriesTag ? [pl.seriesTag] : []);
  return {
    facets,
    overrides: r.overrides && typeof r.overrides === "object" ? r.overrides : {},
    channels: d.channels.map((c, i) => {
      const x = chans?.[i];
      return x && typeof x.source === "string"
        ? { source: x.source, struck: !!x.struck } : c;
    }),
    deselected: (arr(r.deselected) ?? []).filter((k: any) => typeof k === "string"),
    columns: arr(r.columns) ? r.columns.filter((k: any) => typeof k === "string") : null,
    processing: {
      baselineOn: p.baselineOn !== false,
      baseline: pair(p.baseline, d.processing.baseline),
      window: {
        mode: ["reference", "all"].includes(w.mode) ? w.mode : "record",
        range: pair(w.range, d.processing.window.range),
        reference: typeof w.reference === "string" ? w.reference : null,
      },
      cfd: num(p.cfd, d.processing.cfd),
    },
    cuts: (arr(r.cuts) ?? []).filter((c: any) => c && typeof c.quantity === "string"),
    noClip: r.noClip !== false,
    pixels: d.pixels.map((v, i) => {
      const x = arr(r.pixels)?.[i];
      return typeof x === "number" ? x : v;
    }),
    pitch: num(r.pitch, d.pitch),
    plot: {
      recipe,
      quantity: ["charge", "amplitude", "time", "pedestal", "noise"].includes(pl.quantity) ? pl.quantity : d.plot.quantity,
      stat: ["mean", "median", "sigma", "resolution"].includes(pl.stat) ? pl.stat : d.plot.stat,
      err: ["rms", "sem", "none"].includes(pl.err) ? pl.err : d.plot.err,
      channel: pl.channel === "sum" || typeof pl.channel !== "number" ? d.plot.channel : num(pl.channel, 0) as ChanSel,
      seriesFacets: series.filter((s: any) => typeof s === "string" && s),
      xFacet: typeof pl.xFacet === "string" ? pl.xFacet : typeof pl.xTag === "string" ? pl.xTag : "",
      filters: (arr(pl.filters) ?? []).map((f: any) => ({ facet: f?.facet ?? f?.tag, value: String(f?.value ?? "") }))
        .filter((f: Filter) => typeof f.facet === "string")
        // One filter per facet: two on the same one can never both hold.
        .filter((f: Filter, i: number, all: Filter[]) => all.findIndex((g) => g.facet === f.facet) === i),
      fit: pl.fit !== false,
      waveHidden: chList(pl.waveHidden),
      hiddenWindows: (arr(pl.hiddenWindows) ?? []).filter((x: any) => typeof x === "string"),
    },
  };
}

// ---------- facets ----------
export interface FacetInfo { name: string; source: "meta" | "note" | "folder"; kind: "number" | "text" }

export function allFacets(runs: QlRun[], defs: FacetDef[]): FacetInfo[] {
  const out: FacetInfo[] = [];
  const seen = new Set<string>();
  for (const d of defs) {
    if (!seen.has(d.name)) { seen.add(d.name); out.push({ name: d.name, source: d.source, kind: d.kind }); }
  }
  for (const r of runs) {
    for (const k of Object.keys(r.experiment)) {
      if (seen.has(k)) continue;
      seen.add(k);
      const numeric = runs.every((x) => x.experiment[k] === undefined
        || x.experiment[k] === "" || isFinite(Number(x.experiment[k])));
      out.push({ name: k, source: "meta", kind: numeric ? "number" : "text" });
    }
  }
  return out;
}

function safeRegex(p: string): RegExp | null {
  try { return new RegExp(p, "i"); } catch { return null; }
}

export function evalFacet(def: FacetDef, run: QlRun): string | null {
  const re = safeRegex(def.pattern);
  if (!re) return null;
  const m = re.exec(def.source === "folder" ? run.name : run.note);
  if (!m) return null;
  return (m[1] ?? m[0]).trim();
}

/** Every facet's value for every run: hand fixes first, then the pattern or
 *  the metadata. Missing values are absent, never "". */
export function facetValues(runs: QlRun[], defs: FacetDef[], overrides: FolderPrefs["overrides"]):
                            Record<string, Record<string, string>> {
  const facets = allFacets(runs, defs);
  const out: Record<string, Record<string, string>> = {};
  for (const r of runs) {
    const v: Record<string, string> = {};
    for (const t of facets) {
      const def = defs.find((d) => d.name === t.name);
      const val = def ? evalFacet(def, r) : r.experiment[t.name];
      if (val !== undefined && val !== null && val !== "") v[t.name] = val;
    }
    if (r.number !== null) v["run"] = String(r.number);
    for (const [k, x] of Object.entries(overrides[r.key] ?? {})) {
      if (x !== "") v[k] = x;
    }
    out[r.key] = v;
  }
  return out;
}

/** Split a note into clickable pieces: numbers, words, punctuation. */
export function tokenize(s: string): string[] {
  return s.match(/\d+(?:\.\d+)?|[A-Za-z]+[+-]?|[^\sA-Za-z\d]+/g) ?? [];
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A pattern that finds the clicked piece in every run's note, anchored on
 *  its neighbour - "8" before "GeV" becomes "(\d+(?:\.\d+)?)\s*GeV". */
export function suggestPattern(tokens: string[], i: number): { pattern: string; kind: "number" | "text"; describe: string } {
  const tok = tokens[i];
  const next = tokens[i + 1];
  const prev = tokens[i - 1];
  const isNum = /^\d/.test(tok);
  const word = (t?: string) => !!t && /^[A-Za-z]/.test(t);
  if (isNum) {
    if (word(next)) return { pattern: `(\\d+(?:\\.\\d+)?)\\s*${esc(next!)}`, kind: "number", describe: `the number before "${next}"` };
    if (word(prev)) return { pattern: `${esc(prev!)}\\s*(\\d+(?:\\.\\d+)?)`, kind: "number", describe: `the number after "${prev}"` };
    return { pattern: "(\\d+(?:\\.\\d+)?)", kind: "number", describe: "the first number" };
  }
  if (i === 0) return { pattern: "^\\s*([^\\s,;]+)", kind: "text", describe: "the first word" };
  if (prev && !word(prev) && tokens[i - 2]) {
    return { pattern: `${esc(tokens[i - 2])}\\s*${esc(prev)}\\s*([^\\s,;]+)`, kind: "text", describe: `the word after "${tokens[i - 2]}${prev}"` };
  }
  if (prev) return { pattern: `${esc(prev)}\\s+([^\\s,;]+)`, kind: "text", describe: `the word after "${prev}"` };
  return { pattern: `(${esc(tok)})`, kind: "text", describe: `"${tok}"` };
}

// ---------- groups ----------
export interface Group { series: string; x: number | null; runs: string[] }

export function cmpVal(a: string, b: string): number {
  const na = Number(a), nb = Number(b);
  if (a !== "" && b !== "" && isFinite(na) && isFinite(nb)) return na - nb;
  return a.localeCompare(b);
}

export function matches(vals: Record<string, string>, filters: Filter[]): boolean {
  return filters.every((f) => {
    const v = vals[f.facet];
    if (v === undefined) return false;
    const a = Number(v), b = Number(f.value);
    return isFinite(a) && isFinite(b) && f.value !== "" ? a === b : v === f.value;
  });
}

/** The values a facet takes among these runs, in order. */
export function valuesOf(keys: string[], values: Record<string, Record<string, string>>, facet: string): string[] {
  return [...new Set(keys.map((k) => values[k]?.[facet]).filter((v): v is string => v !== undefined))].sort(cmpVal);
}

/** A series' name: its facet values, joined - "5 · A" for pulse_width × mode. */
export const SERIES_SEP = " · ";

export const MAX_SERIES = 8;

/** Runs -> plot groups, one series per combination of the series facets.
 *  Series come out sorted (numerically when they can be, first facet
 *  first), so a numeric facet reads as an ordered ramp of colours. Against
 *  a text facet, x is categorical: its values in order sit at 0, 1, 2...
 *  and `xLabels` names them. */
export function makeGroups(keys: string[], values: Record<string, Record<string, string>>,
                           spec: PlotSpec, kind: Kind, xText = false):
    { groups: Group[]; dropped: number; series: string[]; tooMany: number; xLabels: string[] | null } {
  const bySeries = new Map<string, { parts: string[]; runs: string[] }>();
  let dropped = 0;
  const xOf = (vals: Record<string, string>) => (xText ? 0 : Number(vals[spec.xFacet]));
  for (const k of keys) {
    const vals = values[k] ?? {};
    if (!matches(vals, spec.filters)) continue;
    const parts = spec.seriesFacets.map((f) => vals[f]);
    if (parts.some((p) => p === undefined)) { dropped++; continue; }
    if (kind === "facet" && (!spec.xFacet || vals[spec.xFacet] === undefined || !isFinite(xOf(vals)))) {
      dropped++; continue;
    }
    const name = parts.length ? parts.join(SERIES_SEP) : "all";
    if (!bySeries.has(name)) bySeries.set(name, { parts, runs: [] });
    bySeries.get(name)!.runs.push(k);
  }
  const cmpParts = (a: string[], b: string[]) => {
    for (let i = 0; i < a.length; i++) { const c = cmpVal(a[i], b[i]); if (c) return c; }
    return 0;
  };
  let series = [...bySeries.keys()].sort((a, b) => cmpParts(bySeries.get(a)!.parts, bySeries.get(b)!.parts));
  const tooMany = Math.max(0, series.length - MAX_SERIES);
  series = series.slice(0, MAX_SERIES);
  const xLabels = kind === "facet" && xText
    ? valuesOf(series.flatMap((s) => bySeries.get(s)!.runs), values, spec.xFacet) : null;
  const groups: Group[] = [];
  for (const s of series) {
    const ks = bySeries.get(s)!.runs;
    if (kind === "facet") {
      const byX = new Map<number, string[]>();
      for (const k of ks) {
        const xv = xLabels ? xLabels.indexOf(values[k][spec.xFacet]) : Number(values[k][spec.xFacet]);
        if (!byX.has(xv)) byX.set(xv, []);
        byX.get(xv)!.push(k);
      }
      for (const [xv, rk] of [...byX.entries()].sort((a, b) => a[0] - b[0])) {
        groups.push({ series: s, x: xv, runs: rk });
      }
    } else {
      groups.push({ series: s, x: null, runs: ks });
    }
  }
  return { groups, dropped, series, tooMany, xLabels };
}

/** Series colours, in a fixed order (never cycled): ordered from cool to
 *  warm so a numeric facet like energy reads as a ramp. Identity is never
 *  colour alone - the legend names every series. */
export const SERIES_COLORS = ["#7b5cf5", "#2f8fe6", "#14b8a6", "#7acb4f", "#e6c81e",
                              "#ff7a45", "#e5579b", "#b9c2cc"];

/** The TR0 copy digitized in the same bank as logical channel `ch` - the
 *  one on that channel's own time axis. */
export const bankTr0 = (ch: number) => `tr0:${Math.floor(ch / 8)}`;

export function sourceLabel(src: string): string {
  if (src.startsWith("tr0:")) return "TR0";
  if (src.startsWith("in:")) return `input ${src.slice(3)}`;
  return src;
}

/** "0–7, 9, 12–15": a channel set as a reader says it. */
export function channelRanges(chs: number[]): string {
  const s = [...chs].sort((a, b) => a - b);
  const out: string[] = [];
  for (let i = 0; i < s.length; i++) {
    let j = i;
    while (j + 1 < s.length && s[j + 1] === s[j] + 1) j++;
    out.push(j - i >= 2 ? `${s[i]}–${s[j]}` : j > i ? `${s[i]}, ${s[j]}` : String(s[i]));
    i = j;
  }
  return out.join(", ");
}

export const QUANTITY_LABEL: Record<Quantity, string> = {
  charge: "charge", amplitude: "amplitude", time: "time", pedestal: "pedestal", noise: "noise",
};
export const UNIT: Record<Quantity, string> = {
  charge: "pC", amplitude: "mV", time: "ns", pedestal: "mV", noise: "mV",
};
