/** Quick Look's client-side model: tags, the per-folder settings, and how
 *  runs become plot groups. Tags live here, not on the server - they are
 *  this view's reading of the folder, and Quick Look never writes data. */
import type { ChanSel, ChannelSetting, Cut, Err, Kind, Processing, Quantity, QlRun, Stat } from "./types";

export const N_CH = 16;

/** A tag read out of each run's note (or the folder name) with a pattern.
 *  Tags from the Experiment Conditions need no definition: every key in
 *  the metadata is one automatically. */
export interface TagDef {
  name: string;
  source: "note" | "folder";
  pattern: string;          // regex; the first capture group is the value
  kind: "number" | "text";
}

export interface Filter { tag: string; value: string }

export interface PlotSpec {
  recipe: Recipe;
  quantity: Quantity;
  stat: Stat;
  err: Err;
  channel: ChanSel;
  seriesTag: string;        // "" = one series
  xTag: string;             // vs Tag / Resolution
  filters: Filter[];
  fit: boolean;
  pulseChannel: number;
}

export type Recipe = "waveform" | "hist" | "channel" | "tag" | "resolution" | "spatial";

export const RECIPES: { id: Recipe; label: string; kind: Kind; help: string }[] = [
  { id: "waveform", label: "Waveforms", kind: "waveform", help: "Average pulse of one channel, one line per group" },
  { id: "hist", label: "Distribution", kind: "hist", help: "Histogram of a value on one channel (or the charge sum)" },
  { id: "channel", label: "vs Channel", kind: "channel", help: "A statistic of a value on every channel" },
  { id: "tag", label: "vs Tag", kind: "tag", help: "A statistic against a numeric tag, e.g. linearity vs energy" },
  { id: "resolution", label: "Resolution", kind: "tag", help: "sigma/mean against a numeric tag, with a stochastic/constant/noise fit" },
  { id: "spatial", label: "Spatial", kind: "spatial", help: "Share of charge per pixel and the shower centroid" },
];

export interface FolderPrefs {
  tags: TagDef[];
  overrides: Record<string, Record<string, string>>;   // run key -> tag -> value
  channels: ChannelSetting[];
  deselected: string[];
  processing: Processing;
  polarity: "auto" | "negative" | "positive";
  timingRef: string | null;
  cuts: Cut[];
  noClip: boolean;
  pixels: number[];
  pitch: number;
  plot: PlotSpec;
}

export const DEFAULT_PROCESSING: Processing = {
  baseline: [10, 40],
  window: { mode: "record", range: [60, 120], reference: null },
  cfd: 0.3,
};

export function defaultPrefs(): FolderPrefs {
  return {
    tags: [], overrides: {},
    channels: Array.from({ length: N_CH }, (_, i) => ({ source: `in:${i}`, struck: false })),
    deselected: [],
    processing: DEFAULT_PROCESSING,
    polarity: "auto", timingRef: null,
    cuts: [], noClip: true,
    pixels: Array.from({ length: N_CH }, (_, i) => i), pitch: 3,
    plot: {
      recipe: "channel", quantity: "charge", stat: "mean", err: "rms",
      channel: "sum", seriesTag: "", xTag: "", filters: [], fit: true, pulseChannel: 0,
    },
  };
}

/** Prefs from storage or an imported file: anything malformed falls back
 *  to the default for that field instead of reaching the controls. */
export function sanitize(raw: unknown): FolderPrefs {
  const d = defaultPrefs();
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, any>;
  const arr = (v: unknown) => (Array.isArray(v) ? v : null);
  const num = (v: unknown, f: number) => (typeof v === "number" && isFinite(v) ? v : f);
  const pair = (v: unknown, f: [number, number]): [number, number] => {
    const a = arr(v);
    return a && a.length === 2 ? [num(a[0], f[0]), num(a[1], f[1])] : f;
  };
  const tags = (arr(r.tags) ?? []).filter((t: any) => t && typeof t.name === "string"
    && typeof t.pattern === "string").map((t: any): TagDef => ({
      name: t.name, pattern: t.pattern,
      source: t.source === "folder" ? "folder" : "note",
      kind: t.kind === "text" ? "text" : "number",
    }));
  const chans = arr(r.channels);
  const p = (r.processing ?? {}) as Record<string, any>;
  const w = (p.window ?? {}) as Record<string, any>;
  const pl = (r.plot ?? {}) as Record<string, any>;
  const recipe = RECIPES.some((x) => x.id === pl.recipe) ? pl.recipe : d.plot.recipe;
  return {
    tags,
    overrides: r.overrides && typeof r.overrides === "object" ? r.overrides : {},
    channels: d.channels.map((c, i) => {
      const x = chans?.[i];
      return x && typeof x.source === "string"
        ? { source: x.source, struck: !!x.struck } : c;
    }),
    deselected: (arr(r.deselected) ?? []).filter((k: any) => typeof k === "string"),
    processing: {
      baseline: pair(p.baseline, d.processing.baseline),
      window: {
        mode: w.mode === "reference" ? "reference" : "record",
        range: pair(w.range, d.processing.window.range),
        reference: typeof w.reference === "string" ? w.reference : null,
      },
      cfd: num(p.cfd, d.processing.cfd),
    },
    polarity: ["auto", "negative", "positive"].includes(r.polarity) ? r.polarity : "auto",
    timingRef: typeof r.timingRef === "string" ? r.timingRef : null,
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
      seriesTag: typeof pl.seriesTag === "string" ? pl.seriesTag : "",
      xTag: typeof pl.xTag === "string" ? pl.xTag : "",
      filters: (arr(pl.filters) ?? []).filter((f: any) => f && typeof f.tag === "string")
        .map((f: any) => ({ tag: f.tag, value: String(f.value ?? "") })),
      fit: pl.fit !== false,
      pulseChannel: num(pl.pulseChannel, 0),
    },
  };
}

// ---------- tags ----------
export interface TagInfo { name: string; source: "meta" | "note" | "folder"; kind: "number" | "text" }

export function allTags(runs: QlRun[], defs: TagDef[]): TagInfo[] {
  const out: TagInfo[] = [];
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

export function evalTag(def: TagDef, run: QlRun, folder: string): string | null {
  const re = safeRegex(def.pattern);
  if (!re) return null;
  const m = re.exec(def.source === "folder" ? folder : run.note);
  if (!m) return null;
  return (m[1] ?? m[0]).trim();
}

/** Every tag's value for every run: hand fixes first, then the pattern or
 *  the metadata. Missing values are absent, never "". */
export function tagValues(runs: QlRun[], defs: TagDef[], overrides: FolderPrefs["overrides"],
                          folder: string): Record<string, Record<string, string>> {
  const tags = allTags(runs, defs);
  const out: Record<string, Record<string, string>> = {};
  for (const r of runs) {
    const v: Record<string, string> = {};
    for (const t of tags) {
      const def = defs.find((d) => d.name === t.name);
      const val = def ? evalTag(def, r, folder) : r.experiment[t.name];
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

function cmpVal(a: string, b: string): number {
  const na = Number(a), nb = Number(b);
  if (a !== "" && b !== "" && isFinite(na) && isFinite(nb)) return na - nb;
  return a.localeCompare(b);
}

export function matches(vals: Record<string, string>, filters: Filter[]): boolean {
  return filters.every((f) => {
    const v = vals[f.tag];
    if (v === undefined) return false;
    const a = Number(v), b = Number(f.value);
    return isFinite(a) && isFinite(b) && f.value !== "" ? a === b : v === f.value;
  });
}

export const MAX_SERIES = 8;

/** Runs -> plot groups. Series come out sorted (numerically when they can
 *  be), so a numeric series tag reads as an ordered ramp of colours. */
export function makeGroups(keys: string[], values: Record<string, Record<string, string>>,
                           spec: PlotSpec, kind: Kind): { groups: Group[]; dropped: number; series: string[]; tooMany: number } {
  const bySeries = new Map<string, string[]>();
  let dropped = 0;
  for (const k of keys) {
    const vals = values[k] ?? {};
    if (!matches(vals, spec.filters)) continue;
    const s = spec.seriesTag ? vals[spec.seriesTag] : "all";
    if (s === undefined) { dropped++; continue; }
    if (kind === "tag") {
      const xv = Number(vals[spec.xTag]);
      if (!spec.xTag || vals[spec.xTag] === undefined || !isFinite(xv)) { dropped++; continue; }
    }
    if (!bySeries.has(s)) bySeries.set(s, []);
    bySeries.get(s)!.push(k);
  }
  let series = [...bySeries.keys()].sort(cmpVal);
  const tooMany = Math.max(0, series.length - MAX_SERIES);
  series = series.slice(0, MAX_SERIES);
  const groups: Group[] = [];
  for (const s of series) {
    const ks = bySeries.get(s)!;
    if (kind === "tag") {
      const byX = new Map<number, string[]>();
      for (const k of ks) {
        const xv = Number(values[k][spec.xTag]);
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
  return { groups, dropped, series, tooMany };
}

/** Series colours, in a fixed order (never cycled): ordered from cool to
 *  warm so a numeric tag like energy reads as a ramp. Identity is never
 *  colour alone - the legend names every series. */
export const SERIES_COLORS = ["#7b5cf5", "#2f8fe6", "#14b8a6", "#7acb4f", "#e6c81e",
                              "#ff7a45", "#e5579b", "#b9c2cc"];

export function sourceLabel(src: string): string {
  if (src.startsWith("tr0:")) return `TR0 (group ${src.slice(4)} copy)`;
  if (src.startsWith("in:")) return `input ${src.slice(3)}`;
  return src;
}

export const QUANTITY_LABEL: Record<Quantity, string> = {
  charge: "charge", amplitude: "amplitude", time: "time", pedestal: "pedestal", noise: "noise",
};
export const UNIT: Record<Quantity, string> = {
  charge: "pC", amplitude: "mV", time: "ns", pedestal: "mV", noise: "mV",
};
