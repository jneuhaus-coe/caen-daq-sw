import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePersistentState } from "../persist";
import { qlApi } from "./api";
import type { Analysis, ChanSel, Cut, QlFolder, QlFolderEntry, QlRun, Quantity } from "./types";
import {
  N_CH, RECIPES, SERIES_COLORS, SERIES_SEP, UNIT, allFacets, bankTr0, channelRanges, defaultChannels,
  facetValues, makeGroups, matches, sanitize, sourceLabel, valuesOf, wireProcessing,
  type FacetDef, type Filter, type FolderPrefs, type PlotSpec, type ProcPrefs, type Recipe,
} from "./model";
import { Chart, download, exportPng, fmt, type ChartSeries, type Tick } from "./Chart";
import { Multiples, exportPanelsPng, type Panel } from "./Multiples";
import { FacetBuilder } from "./FacetBuilder";
import { Popover } from "./Popover";

/** Quick Look: preliminary analysis of recorded runs, for the "do we need
 *  to rerun anything?" check before leaving. Strictly read-only: every
 *  setting here (facets, channel map, cuts) is this view's, kept in the
 *  browser; the data files are never touched. Exports are downloads. */

const QUANTITIES: Quantity[] = ["charge", "amplitude", "time", "pedestal", "noise"];
const NEEDS_BASELINE: Quantity[] = ["pedestal", "noise"];
const STAT_LABEL = { mean: "mean", median: "median", sigma: "σ (core)" } as const;
const OTHER = "\u0000other";

type Store = Record<string, unknown>;

export function QuickLook({ onError }: { onError: (title: string, lines?: string[]) => void }) {
  const [folderId, setFolderId] = usePersistentState("ql:folder", "");
  const [store, setStore] = usePersistentState<Store>("ql:prefs", {});
  const [folders, setFolders] = useState<QlFolderEntry[] | null>(null);
  const [dataDir, setDataDir] = useState("");
  const [folder, setFolder] = useState<QlFolder | null>(null);
  const [folderErr, setFolderErr] = useState("");
  const [otherPath, setOtherPath] = usePersistentState("ql:otherPath", "");
  const [showOther, setShowOther] = useState(false);
  const [result, setResult] = useState<Analysis | null>(null);
  const [busy, setBusy] = useState(false);
  const [facetDialog, setFacetDialog] = useState<{ def: FacetDef | null } | null>(null);
  const [chOpen, setChOpen] = useState<number | null>(null);
  const [cutEdit, setCutEdit] = useState<number | "new" | null>(null);   // a cut's index, or a new one
  // Closing a cut's form hands focus back to its chip, so Enter/Escape
  // never strands the keyboard on the page.
  const closeCut = (i: number) => {
    setCutEdit(null);
    requestAnimationFrame(() => document.querySelector<HTMLElement>(`[data-cut="${i}"]`)?.focus());
  };
  const [addFilter, setAddFilter] = useState(false);
  const [colDrag, setColDrag] = useState<{ from: string; over: string | null } | null>(null);
  const [procOpen, setProcOpen] = usePersistentState("ql:procOpen", false);
  // Drag-to-set (the legend's window column, channel squares, the channel
  // picker): while the button is held, every toggle of the same group the
  // pointer passes over takes the value the first one took.
  const paint: Paint = useRef(null);
  useEffect(() => {
    const move = (e: PointerEvent) => { if (paint.current) paintAlong(paint.current, e.clientX, e.clientY); };
    const stop = () => { paint.current = null; };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
  }, []);
  const chartRef = useRef<SVGSVGElement | null>(null);
  const panelsRef = useRef<HTMLDivElement | null>(null);

  const prefs: FolderPrefs = useMemo(() => sanitize(store[folderId]), [store, folderId]);
  const setPrefs = useCallback((fn: (p: FolderPrefs) => FolderPrefs) => {
    setStore((s) => ({ ...s, [folderId]: fn(sanitize(s[folderId])) }));
  }, [folderId, setStore]);
  const setPlot = (patch: Partial<PlotSpec>) => setPrefs((p) => ({ ...p, plot: { ...p.plot, ...patch } }));

  // ---- the folder list and the open folder ----
  const loadFolders = useCallback(() => {
    qlApi.folders().then((r) => { setFolders(r.folders); setDataDir(r.data_dir); })
      .catch(() => setFolders((f) => f ?? []));
  }, []);
  useEffect(() => {
    loadFolders();
    const id = window.setInterval(loadFolders, 15000);
    return () => window.clearInterval(id);
  }, [loadFolders]);
  useEffect(() => {
    if (!folderId && folders && folders.length) setFolderId(folders[0].id);
  }, [folders, folderId, setFolderId]);
  useEffect(() => {
    if (!folderId) { setFolder(null); return; }
    let live = true;
    const load = () => qlApi.folder(folderId)
      .then((f) => { if (live) { setFolder(f); setFolderErr(""); } })
      .catch((e) => { if (live) { setFolder(null); setFolderErr(String(e.message || e)); } });
    load();
    const id = window.setInterval(load, 10000);
    return () => { live = false; window.clearInterval(id); };
  }, [folderId]);

  const runs: QlRun[] = folder?.runs ?? [];
  const usable = (r: QlRun) => r.state === "ok" || r.state === "unfinished";
  const selected = runs.filter((r) => usable(r) && !prefs.deselected.includes(r.key)).map((r) => r.key);
  const facets = useMemo(() => allFacets(runs, prefs.facets), [runs, prefs.facets]);
  const values = useMemo(() => facetValues(runs, prefs.facets, prefs.overrides),
    [runs, prefs.facets, prefs.overrides]);
  const facetNames = ["run", ...facets.map((t) => t.name)];
  const numericFacets = ["run", ...facets.filter((t) => t.kind === "number").map((t) => t.name)];

  const spec = prefs.plot;
  const recipe = RECIPES.find((r) => r.id === spec.recipe) ?? RECIPES[2];
  const kind = recipe.kind;
  // vs Facet takes any facet (a text one is categorical); Resolution's fit
  // needs a number.
  const xChoices = spec.recipe === "resolution" ? numericFacets : facetNames;
  const xFacet = xChoices.includes(spec.xFacet) ? spec.xFacet
    : (numericFacets.find((t) => t !== "run") ?? "run");
  // Categorical when any value is not a number - whatever kind the facet
  // was declared, a non-number can never sit on a numeric axis.
  const xText = spec.recipe === "facet"
    && selected.some((k) => { const v = values[k]?.[xFacet]; return v !== undefined && !isFinite(Number(v)); });
  // A facet a where-filter pins has one value: it drops out of the split
  // while the filter stands, and comes back when the filter goes.
  const seriesFacets = spec.seriesFacets.filter((f) => facetNames.includes(f)
    && !(kind === "facet" && f === xFacet) && !spec.filters.some((x) => x.facet === f));
  const effSpec: PlotSpec = { ...spec, xFacet, seriesFacets };
  const { groups, dropped, tooMany, xLabels } = useMemo(
    () => makeGroups(selected, values, effSpec, kind, xText),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [JSON.stringify(selected), values, JSON.stringify(effSpec), kind, xText]);
  const xName = (x: number | null | undefined) => (xLabels ? xLabels[x ?? -1] ?? "" : fmt(x));
  const seriesNames = [...new Set(groups.map((g) => g.series))];
  const colorOf = (s: string) => SERIES_COLORS[seriesNames.indexOf(s)] ?? SERIES_COLORS[0];
  const seriesLabel = (s: string) => {
    if (!seriesFacets.length) return "all selected runs";
    const parts = s.split(SERIES_SEP);
    return seriesFacets.map((f, i) => `${f} = ${parts[i] ?? ""}`).join(", ");
  };

  // ---- channels: which are in use, and which each panel shows ----
  const live = (i: number) => !prefs.channels[i].struck && prefs.channels[i].source !== "off";
  const inUseCh = Array.from({ length: N_CH }, (_, i) => i).filter(live);
  const allCh = Array.from({ length: N_CH }, (_, i) => i);
  // Struck channels stay pickable: their pulses show, masked "excluded".
  const waveChannels = allCh.filter((i) => !spec.waveHidden.includes(i));
  const channelsChanged = JSON.stringify(prefs.channels) !== JSON.stringify(defaultChannels());
  // Functional updates: a drag across the channels sets several per render.
  const setStruck = (ch: number, struck: boolean) => setPrefs((p) => ({
    ...p, channels: p.channels.map((c, i) => i === ch ? { ...c, struck } : c) }));
  const setWaveShown = (ch: number, on: boolean) => setPrefs((p) => {
    const hidden = p.plot.waveHidden.filter((x) => x !== ch);
    return { ...p, plot: { ...p.plot, waveHidden: on ? hidden : [...hidden, ch] } };
  });

  // ---- the request: rebuilt from state, sent when it changes, re-polled while passes run ----
  const processing = wireProcessing(prefs.processing);
  const baselineOff = processing.baseline === null;
  const stat = spec.recipe === "resolution" ? "resolution" : spec.stat;
  const channelForPlot: ChanSel = spec.channel === "sum" && spec.quantity !== "charge" ? 0 : spec.channel;
  const req = folder ? {
    folder: folderId, runs: selected, processing, channels: prefs.channels,
    cuts: prefs.cuts, no_clip: prefs.noClip,
    plot: { kind, quantity: spec.quantity, stat, err: spec.err, channel: channelForPlot,
            fit: spec.fit, pixels: prefs.pixels, pitch: prefs.pitch, rows: 4, cols: 4,
            ...(kind === "waveform" ? { channels: waveChannels } : {}) },
    groups,
  } : null;
  const reqKey = JSON.stringify(req);
  useEffect(() => {
    if (!req) { setResult(null); return; }
    let live = true;
    let timer: number | undefined;
    const ctl = new AbortController();
    const go = () => {
      setBusy(true);
      qlApi.analyse(req, ctl.signal).then((r) => {
        if (!live) return;
        setResult(r);
        setBusy(false);
        if (!r.progress.done) timer = window.setTimeout(go, 1000);
      }).catch((e) => {
        if (!live || e?.name === "AbortError") return;
        setBusy(false);
        onError("Quick Look could not analyse this folder", [String(e.message || e)]);
      });
    };
    timer = window.setTimeout(go, 150);
    return () => { live = false; ctl.abort(); window.clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reqKey]);

  // ---- helpers ----
  const chSub = (i: number) => {
    const c = prefs.channels[i];
    return c.source !== `in:${i}` ? sourceLabel(c.source) : undefined;
  };
  const chLabel = (i: number) => {
    const c = prefs.channels[i];
    const sub = chSub(i);
    return c.struck ? `ch ${i} (struck)` : sub ? `ch ${i} · ${sub}` : `ch ${i}`;
  };

  // ---- runs table ----
  const health = (r: QlRun): { text: string; cls: string; title: string } => {
    if (r.state === "recording") return { text: "recording", cls: "live", title: r.reason };
    if (r.state === "unsupported") return { text: "not supported", cls: "warn", title: r.reason };
    const h = result?.runs[r.key];
    if (prefs.deselected.includes(r.key)) return { text: "", cls: "", title: "" };
    if (!h) return { text: "…", cls: "", title: "Not read yet" };
    if (h.state === "error") return { text: "read failed", cls: "bad", title: h.error ?? "" };
    if (h.state === "pending") return { text: "reading", cls: "", title: "Reading the first events" };
    const bits: string[] = [], tips: string[] = [];
    if ((h.clip_frac ?? 0) >= 0.01) {
      bits.push(`clip ${Math.round((h.clip_frac ?? 0) * 100)}%`);
      tips.push(`${((h.clip_frac ?? 0) * 100).toFixed(1)}% of events clip on a channel in use`);
    }
    if (h.ped_shift) {
      bits.push(`ped ${h.ped_shift.mv > 0 ? "+" : ""}${h.ped_shift.mv} mV`);
      tips.push(`Pedestal on ch ${h.ped_shift.channel} is ${h.ped_shift.mv} mV off the other selected runs`);
    }
    if (h.state === "preview") tips.push("Preview: first events only");
    return bits.length ? { text: bits.join(" · "), cls: "warn", title: tips.join("\n") }
      : { text: "ok", cls: "ok", title: tips.join("\n") };
  };
  // Until you pick columns, the two facets this plot uses come first, then
  // facets read from the notes, then the metadata's.
  const used = [...seriesFacets, kind === "facet" ? xFacet : "", ...spec.filters.map((f) => f.facet)];
  const rank = (t: { name: string; source: string }) =>
    (used.includes(t.name) ? 0 : t.source === "meta" ? 2 : 1);
  const autoColumns = [...facets].sort((a, b) => rank(a) - rank(b)).slice(0, 2).map((t) => t.name);
  const columns = (prefs.columns ?? autoColumns).filter((c) => facets.some((t) => t.name === c));
  const toggleColumn = (name: string) => setPrefs((p) => {
    const cur = (p.columns ?? autoColumns).filter((c) => facets.some((t) => t.name === c));
    return { ...p, columns: cur.includes(name) ? cur.filter((c) => c !== name) : [...cur, name] };
  });
  const moveColumn = (name: string, to: number) => setPrefs((p) => {
    const cur = columns.filter((c) => c !== name);
    cur.splice(Math.max(0, Math.min(cur.length, to)), 0, name);
    return { ...p, columns: cur };
  });
  const allChecked = runs.filter(usable).every((r) => !prefs.deselected.includes(r.key));
  const toggleRun = (k: string) => setPrefs((p) => ({
    ...p, deselected: p.deselected.includes(k) ? p.deselected.filter((x) => x !== k) : [...p.deselected, k],
  }));
  const inPlot = new Set(groups.flatMap((g) => g.runs));

  // ---- plot data -> chart ----
  const plot = result?.plot;
  const unit = UNIT[spec.quantity];
  const statWord = stat === "resolution" ? "σ/mean" : STAT_LABEL[stat as keyof typeof STAT_LABEL];
  const runName = (k: string) => {
    const r = runs.find((x) => x.key === k);
    return r?.number != null ? String(r.number) : k;
  };
  let chart: { series: ChartSeries[]; xLabel: string; yLabel: string; xTicks?: Tick[]; bands?: { x0: number; x1: number; label: string }[]; dodge?: boolean; zeroY?: boolean } | null = null;
  let wavePanels: Panel[] | null = null;
  if (plot && plot.kind === kind && kind !== "spatial") {
    if (kind === "channel") {
      const struck = prefs.channels.map((c, i) => c.struck ? i : -1).filter((i) => i >= 0);
      chart = {
        xLabel: "channel", yLabel: `${statWord} ${spec.quantity} (${unit})`, dodge: true,
        zeroY: spec.quantity === "charge" || spec.quantity === "amplitude",
        xTicks: Array.from({ length: N_CH }, (_, i) => ({
          value: i, label: String(i), dim: prefs.channels[i].struck,
          sub: prefs.channels[i].source.startsWith("tr0") ? "TR0" : undefined })),
        bands: struck.map((i) => ({ x0: i - 0.5, x1: i + 0.5, label: "struck" })),
        series: plot.series.map((s) => ({
          name: seriesLabel(s.name), color: colorOf(s.name), line: true,
          points: (s.points ?? []).map((p) => ({
            x: p.x ?? NaN, y: p.y ?? NaN, err: p.err ?? null,
            tip: <>
              <span>ch {p.x}</span>
              <span className="mono">{fmt(p.y)}{p.err ? ` ± ${fmt(p.err, 2)}` : ""} {unit} {spec.err !== "none" ? <span className="muted">({spec.err.toUpperCase()})</span> : null}</span>
              <span className="muted">{(s.runs ?? []).length > 1 ? `${(s.runs ?? []).length} runs pooled (${(s.runs ?? []).map(runName).join(", ")})` : `run ${runName((s.runs ?? [])[0] ?? "")}`} · {(p.n ?? 0).toLocaleString()} ev</span>
              {(s.runs ?? []).length > 1 && p.per_run ? <span className="muted">per run: {Object.values(p.per_run).map((v) => fmt(v)).join(" / ")}</span> : null}
              <span className="ql-tip-btns">
                <button className="mini" onClick={() => p.x != null && setPrefs((q) => ({ ...q, channels: q.channels.map((c, i) => i === p.x ? { ...c, struck: true } : c) }))}>Strike ch {p.x}</button>
              </span>
            </>,
          })),
        })),
      };
    } else if (kind === "facet") {
      chart = {
        xLabel: xFacet, yLabel: stat === "resolution" ? `σ/mean of ${spec.quantity}` : `${statWord} ${spec.quantity} (${unit})`,
        zeroY: true,
        ...(xLabels ? { xTicks: xLabels.map((l, i) => ({ value: i, label: l })), dodge: true } : {}),
        series: plot.series.map((s) => ({
          name: seriesLabel(s.name), color: colorOf(s.name), line: true,
          fit: s.fit?.curve,
          points: (s.points ?? []).map((p) => ({
            x: p.x ?? NaN, y: p.y ?? NaN, err: p.err ?? null,
            tip: <>
              <span>{xFacet} = {xName(p.x)}</span>
              <span className="mono">{stat === "resolution" ? `${fmt((p.y ?? 0) * 100)}%` : `${fmt(p.y)} ${unit}`}{p.err ? ` ± ${stat === "resolution" ? fmt((p.err ?? 0) * 100, 2) + "%" : fmt(p.err, 2)}` : ""}</span>
              <span className="muted">runs {(p.runs ?? []).map(runName).join(", ")} · {(p.n ?? 0).toLocaleString()} ev</span>
            </>,
          })),
        })),
      };
    } else if (kind === "hist" && plot.edges) {
      const e = plot.edges;
      chart = {
        xLabel: `${spec.quantity} (${unit}) on ${channelForPlot === "sum" ? "Σ all channels" : chLabel(channelForPlot as number)}`,
        yLabel: "events", zeroY: true,
        series: plot.series.map((s) => ({
          name: seriesLabel(s.name), color: colorOf(s.name), step: true, markers: false,
          points: (s.counts ?? []).map((c, i) => ({
            x: (e[i] + e[i + 1]) / 2, y: c,
            tip: <><span className="mono">{fmt(e[i])} – {fmt(e[i + 1])} {unit}: {c} ev</span>
              <span className="muted">mean {fmt(s.stats?.mean)} · RMS {fmt(s.stats?.rms)} · core σ {fmt(s.stats?.core_sigma)}</span></>,
          })),
        })),
      };
    } else if (kind === "waveform") {
      wavePanels = (plot.channels ?? []).map((ch) => ({
        ch, title: `ch ${ch}`, sub: chSub(ch), excluded: prefs.channels[ch].struck,
        lines: plot.series.flatMap((s) => {
          const tr = (s.traces ?? []).find((x) => x.channel === ch);
          return tr ? [{ name: seriesFacets.length ? s.name : "all", color: colorOf(s.name), t: tr.t, v: tr.v }] : [];
        }),
      }));
    }
  }
  const hasLegend = kind === "waveform" ? !!wavePanels?.some((p) => p.lines.length) : !!chart?.series.length;
  // With a window per series there is something to choose: which to draw.
  const winCol = kind === "waveform" && prefs.processing.window.mode === "reference" && seriesNames.length > 1;
  const showWin = (s: string) => !spec.hiddenWindows.includes(s);
  const setWin = (s: string, on: boolean) => setPrefs((p) => {
    const hidden = p.plot.hiddenWindows.filter((x) => x !== s);
    return { ...p, plot: { ...p.plot, hiddenWindows: on ? hidden : [...hidden, s] } };
  });

  // ---- exports (downloads only) ----
  const base = `${folder?.folder ?? "quicklook"}-${spec.recipe}`;
  const csv = () => {
    if (!plot) return;
    const rows: string[][] = [];
    if (kind === "channel") {
      rows.push(["series", "channel", "source", "y", "err", "n"]);
      for (const s of plot.series) for (const p of s.points ?? []) {
        rows.push([s.name, String(p.x), prefs.channels[p.x ?? 0]?.source ?? "", String(p.y ?? ""), String(p.err ?? ""), String(p.n ?? "")]);
      }
    } else if (kind === "facet") {
      rows.push(["series", xFacet, "y", "err", "n", "runs"]);
      for (const s of plot.series) for (const p of s.points ?? []) {
        rows.push([s.name, xName(p.x), String(p.y ?? ""), String(p.err ?? ""), String(p.n ?? ""), (p.runs ?? []).map(runName).join(" ")]);
      }
    } else if (kind === "hist") {
      rows.push(["series", "bin_lo", "bin_hi", "count"]);
      for (const s of plot.series) (s.counts ?? []).forEach((c, i) => rows.push([s.name, String(plot.edges![i]), String(plot.edges![i + 1]), String(c)]));
    } else if (kind === "waveform") {
      rows.push(["series", "channel", "t_ns", "mV"]);
      for (const s of plot.series) for (const tr of s.traces ?? []) {
        tr.t.forEach((t, i) => rows.push([s.name, String(tr.channel), String(t), String(tr.v[i])]));
      }
    } else if (kind === "spatial") {
      rows.push(["series", "pixel", "channel", "share"]);
      for (const s of plot.series) (s.cells ?? []).forEach((c, i) => rows.push([s.name, String(i), String(c.channel), String(c.share ?? "")]));
    }
    const text = rows.map((r) => r.map((c) => /[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c).join(",")).join("\n");
    download(new Blob([text + "\n"], { type: "text/csv" }), `${base}.csv`);
  };
  const png = () => {
    if (kind === "waveform") { if (panelsRef.current) exportPanelsPng(panelsRef.current, `${base}.png`); }
    else if (chartRef.current) exportPng(chartRef.current, `${base}.png`);
  };
  const exportSettings = () => {
    const body = JSON.stringify({ app: "dt5742b-daq quick look", folder: folder?.folder, settings: prefs }, null, 2);
    download(new Blob([body], { type: "application/json" }), `${folder?.folder ?? "quicklook"}-settings.json`);
  };
  const loadSettings = (file: File) => {
    file.text().then((t) => {
      const j = JSON.parse(t);
      setPrefs(() => sanitize(j?.settings ?? j));
    }).catch(() => onError("That file is not a Quick Look settings file"));
  };

  // ---- small pieces of UI (plain functions, not components: a component
  // defined in here would remount on every poll and close an open dropdown) ----
  const chanSelect = (value: ChanSel, onChange: (v: ChanSel) => void, allowSum = false) => (
    <select className="ql-slot" aria-label="Channel" value={String(value)}
      onChange={(e) => onChange(e.target.value === "sum" ? "sum" : Number(e.target.value))}>
      {allowSum ? <option value="sum">Σ all channels</option> : null}
      {Array.from({ length: N_CH }, (_, i) => (
        <option key={i} value={i} disabled={prefs.channels[i].struck}>{chLabel(i)}</option>
      ))}
    </select>
  );
  const plotChan = (allowSum: boolean) =>
    chanSelect(allowSum ? channelForPlot : (typeof spec.channel === "number" ? spec.channel : 0),
               (v) => setPlot({ channel: v }), allowSum);

  /** Which channels the Waveforms panels show: a 16-key grid in the
   *  Channels card's layout. A struck channel can be shown; it is masked. */
  const channelPicker = (hidden: number[], setShown: (ch: number, on: boolean) => void,
                         setHidden: (h: number[]) => void, ariaLabel: string) => {
    const shown = allCh.filter((i) => !hidden.includes(i));
    const label = shown.length === N_CH ? `all ${N_CH} channels`
      : !shown.length ? "no channels" : `ch ${channelRanges(shown)}`;
    return (
      <Popover ariaLabel={ariaLabel} label={label}>
        {(close) => (
          <div className="ql-chpick">
            <div className="ql-chans" role="group" aria-label="Channels">
              {Array.from({ length: N_CH }, (_, i) => {
                const on = !hidden.includes(i);
                return (
                  <button key={i} type="button" role="checkbox" aria-checked={on} aria-label={`ch ${i}`}
                    className={"ql-ch" + (on ? " on" : "") + (live(i) ? "" : " off")}
                    title={live(i) ? undefined : "Struck: shown masked, left out of the analysis"}
                    {...paintProps("show", on, (v) => setShown(i, v), paint)}>
                    <span className="mono">{i}</span><small>{chSub(i) ?? ""}</small>
                  </button>
                );
              })}
            </div>
            <div className="ql-row-between">
              <span>
                <button className="mini" onClick={() => setHidden([])}>All</button>{" "}
                <button className="mini" onClick={() => setHidden(allCh)}>None</button>
              </span>
              <button className="mini" onClick={close}>Done</button>
            </div>
          </div>
        )}
      </Popover>
    );
  };

  /** One line per a combination of facets: a checklist, in the order picked. */
  const seriesMenu = (exclude?: string) => {
    const fixed = new Map(spec.filters.map((f) => [f.facet, f.value]));
    const label = seriesFacets.length ? seriesFacets.join(" × ") : "nothing (one line)";
    return (
      <Popover ariaLabel="One line per" label={label}>
        {(close) => (
          <div className="ql-checklist">
            {facetNames.filter((t) => t !== exclude).map((t) => {
              const on = seriesFacets.includes(t);
              const picked = spec.seriesFacets.filter((x) => x !== t);
              return (
                <label key={t} className={"ql-check" + (fixed.has(t) ? " dim" : "")}
                  title={fixed.has(t) ? `Fixed to ${fixed.get(t)} by "where" - remove that filter to split by it` : undefined}>
                  <input type="checkbox" checked={on} disabled={fixed.has(t)}
                    onChange={() => setPlot({ seriesFacets: on ? picked : [...picked, t] })} />
                  {t}
                  {on && seriesFacets.length > 1 ? <span className="muted mono">{seriesFacets.indexOf(t) + 1}</span> : null}
                </label>
              );
            })}
            <div className="ql-row-between">
              <button className="mini" disabled={!seriesFacets.length} onClick={() => setPlot({ seriesFacets: [] })}>One line</button>
              <button className="mini" onClick={close}>Done</button>
            </div>
          </div>
        )}
      </Popover>
    );
  };
  const qSelect = (only?: Quantity[]) => (
    <select className="ql-slot" aria-label="Quantity" value={spec.quantity}
      onChange={(e) => setPlot({ quantity: e.target.value as Quantity })}>
      {(only ?? QUANTITIES).map((q) => (
        <option key={q} value={q} disabled={baselineOff && NEEDS_BASELINE.includes(q)}>
          {q}{baselineOff && NEEDS_BASELINE.includes(q) ? " (needs a baseline)" : ""}</option>
      ))}
    </select>
  );
  const statSelect = () => (
    <select className="ql-slot" aria-label="Statistic" value={spec.stat}
      onChange={(e) => setPlot({ stat: e.target.value as PlotSpec["stat"] })}>
      <option value="mean">mean</option><option value="median">median</option><option value="sigma">σ (core)</option>
    </select>
  );
  const xSelect = () => (
    <select className="ql-slot" aria-label="X axis facet" value={xFacet} onChange={(e) => setPlot({ xFacet: e.target.value })}>
      {xChoices.map((t) => <option key={t} value={t}>{t}</option>)}
    </select>
  );
  // A filter's choices come from the runs the OTHER filters let through, so
  // every value offered matches something.
  const poolFor = (fs: Filter[]) => selected.filter((k) => matches(values[k] ?? {}, fs));
  const setFilter = (i: number, f: Filter | null) =>
    setPlot({ filters: f ? spec.filters.map((x, k) => k === i ? f : x) : spec.filters.filter((_, k) => k !== i) });
  const freeFacets = facetNames.filter((t) => !spec.filters.some((f) => f.facet === t));
  const filters = () => (
    <>
      {spec.filters.length ? <span>, where</span> : null}
      {spec.filters.map((f, i) => {
        const vals = valuesOf(poolFor(spec.filters.filter((_, k) => k !== i)), values, f.facet);
        if (!vals.includes(f.value)) vals.unshift(f.value);
        return (
          <span key={f.facet} className="ql-slot filter">{f.facet} =
            <select className="ql-filter-value" aria-label={`Where ${f.facet}`} value={f.value}
              onChange={(e) => setFilter(i, { ...f, value: e.target.value })}>
              {vals.map((v) => <option key={v} value={v}>{v}</option>)}
            </select>
            <button className="ql-x" aria-label={`Remove where ${f.facet} = ${f.value}`}
              onClick={() => setFilter(i, null)}>×</button>
          </span>
        );
      })}
      {addFilter ? <FilterForm facetNames={freeFacets}
        valuesOf={(t) => valuesOf(poolFor(spec.filters), values, t)}
        onAdd={(f) => { setPlot({ filters: [...spec.filters, f] }); setAddFilter(false); }}
        onCancel={() => setAddFilter(false)} />
        : freeFacets.length ? <button className="ql-slot add" onClick={() => setAddFilter(true)}>+ where</button> : null}
    </>
  );
  // Error bars sit with the legend, not in the sentence: they qualify the
  // marks, and the sentence stays one line.
  const hasErr = (kind === "channel" || kind === "facet") && spec.recipe !== "resolution" && spec.stat !== "sigma";

  const sentence = (() => {
    const sumOk = spec.quantity === "charge";
    switch (spec.recipe) {
      case "waveform": return <>Average pulse on {channelPicker(spec.waveHidden, setWaveShown, (h) => setPlot({ waveHidden: h }), "Channels to plot")}, one line per {seriesMenu()}{filters()}</>;
      case "hist": return <>Histogram of {qSelect()} on {plotChan(sumOk)}, one line per {seriesMenu()}{filters()}</>;
      case "channel": return <>Plot {statSelect()} {qSelect()} vs channel, one series per {seriesMenu()}{filters()}</>;
      case "facet": return <>Plot {statSelect()} {qSelect()} on {plotChan(sumOk)} vs {xSelect()}, one series per {seriesMenu(xFacet)}{filters()}</>;
      case "resolution": return <>Resolution (σ/mean) of {qSelect(["charge", "amplitude"])} on {plotChan(sumOk)} vs {xSelect()}, one series per {seriesMenu(xFacet)}{filters()}<span className="ql-grow" />
        <label className="ql-check"><input type="checkbox" checked={spec.fit} onChange={(e) => setPlot({ fit: e.target.checked })} /> fit a/√x ⊕ b ⊕ c/x</label></>;
      case "spatial": return <>Share of charge per pixel, one map per {seriesMenu()}{filters()}</>;
    }
  })();

  // ---- status line ----
  const pg = result?.progress;
  const status = !folder ? "" : !selected.length ? "No runs selected." : !pg ? "Starting…"
    : pg.done ? `Computed on ${pg.total} run${pg.total === 1 ? "" : "s"} · ${result!.events.toLocaleString()} events, at low priority - the readout is not affected.${pg.errors ? ` ${pg.errors} could not be read.` : ""}`
    : `Preview from the first events of each run · full pass ${Math.round(pg.frac * 100)}% (${pg.full} of ${pg.total} runs done)`;

  const passFrac = result && result.events ? result.passed / result.events : null;
  const emptyText = !folder ? "Open a folder to begin." : !selected.length ? "Select some runs." : !groups.length ? "No runs match this plot." : "Reading…";
  const proc = prefs.processing;
  const refMissing = proc.window.mode === "reference" && result
    ? seriesNames.filter((n) => result.ref_t0?.[n] === null) : [];

  // ---- render ----
  return (
    <div className="ql">
      <aside className="ql-side">
        <div className="card ql-card">
          <div className="ql-row-between"><h2>Runs</h2>
            <label className="mini-file" title="Load settings exported from Quick Look">
              <input type="file" accept="application/json,.json" hidden
                onChange={(e) => { const f = e.target.files?.[0]; if (f) loadSettings(f); e.target.value = ""; }} />
              <span className="button mini">Load settings…</span>
            </label>
          </div>
          <label className="ql-field">Folder
            <select aria-label="Folder" value={showOther ? OTHER : folderId} onChange={(e) => {
              if (e.target.value === OTHER) { setShowOther(true); return; }
              setShowOther(false); setFolderId(e.target.value); setChOpen(null);
            }}>
              {folders && !folders.length && !folderId ? <option value="">No run folders yet</option> : null}
              {folderId && folders && !folders.some((f) => f.id === folderId) ? <option value={folderId}>{folderId}</option> : null}
              {(folders ?? []).map((f) => (
                <option key={f.id} value={f.id}>{f.label || f.id} · {f.runs} run{f.runs === 1 ? "" : "s"}{!f.runs && f.wavedump ? " (WaveDump)" : ""}</option>
              ))}
              <option value={OTHER}>Other folder…</option>
            </select>
          </label>
          {showOther ? (
            <div className="ql-inline-form">
              <input className="mono" style={{ flex: 1 }} placeholder="Full path to a run folder" value={otherPath}
                aria-label="Full path to a run folder" onChange={(e) => setOtherPath(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter" && otherPath.trim()) { setFolderId(otherPath.trim()); setShowOther(false); } }} />
              <button className="mini primary" disabled={!otherPath.trim()}
                onClick={() => { setFolderId(otherPath.trim()); setShowOther(false); }}>Open</button>
            </div>
          ) : null}
          {folderErr ? <div className="ql-warn">{folderErr}</div> : null}
          {folders && !folders.length && !folderId ? <p className="muted">Nothing recorded in {dataDir} yet.</p> : null}
          {folder ? (
            <>
              <div className="ql-facets">
                <span className="muted">Facets</span>
                {facets.map((t) => {
                  const on = columns.includes(t.name);
                  const src = t.source === "meta" ? "meta" : t.source === "folder" ? "run folder" : "note";
                  return (
                    <span key={t.name} className={"ql-chip" + (on ? " on" : "")}>
                      <button className="ql-chip-main" aria-pressed={on}
                        title={`${on ? "Hide" : "Show"} the ${t.name} column · ${t.source === "meta" ? "from the Experiment Conditions in each run's metadata" : `read from the ${src} names`}`}
                        onClick={() => toggleColumn(t.name)}>{t.name} <span className="src">{src}</span></button>
                      {t.source !== "meta" ? (
                        <button className="ql-chip-edit" aria-label={`Edit facet ${t.name}`} title="Edit"
                          onClick={() => setFacetDialog({ def: prefs.facets.find((d) => d.name === t.name) ?? null })}>
                          <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden="true">
                            <path d="M8.2 1.8l2 2L4 10H2V8z" />
                          </svg>
                        </button>
                      ) : null}
                    </span>
                  );
                })}
                <button className="mini dashed" onClick={() => setFacetDialog({ def: null })}>+ Facet from name</button>
              </div>
              <div className="ql-table-wrap">
                <table className="ql-table">
                  <thead><tr>
                    <th><input type="checkbox" aria-label="Select all runs" checked={allChecked}
                      onChange={() => setPrefs((p) => ({ ...p, deselected: allChecked ? runs.filter(usable).map((r) => r.key) : [] }))} /></th>
                    <th>Run</th>
                    {columns.map((c, i) => (
                      <th key={c} className={"ql-th-move" + (colDrag?.over === c && colDrag.from !== c ? " drop" : "") + (colDrag?.from === c ? " lift" : "")}
                        draggable tabIndex={0} aria-label={`${c} column`}
                        title="Drag to move · Alt+←/→ from the keyboard"
                        onDragStart={(e) => { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", c); setColDrag({ from: c, over: null }); }}
                        onDragOver={(e) => { if (colDrag) { e.preventDefault(); if (colDrag.over !== c) setColDrag({ ...colDrag, over: c }); } }}
                        onDrop={(e) => { e.preventDefault(); if (colDrag) moveColumn(colDrag.from, i); setColDrag(null); }}
                        onDragEnd={() => setColDrag(null)}
                        onKeyDown={(e) => {
                          if (!e.altKey || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
                          e.preventDefault();
                          moveColumn(c, i + (e.key === "ArrowLeft" ? -1 : 1));
                          const th = e.currentTarget;
                          requestAnimationFrame(() => (th.parentElement?.querySelector(`[aria-label="${CSS.escape(c)} column"]`) as HTMLElement | null)?.focus());
                        }}>{c}</th>
                    ))}
                    <th className="num">events</th><th>check</th>
                  </tr></thead>
                  <tbody>
                    {runs.map((r) => {
                      const h = health(r);
                      const dim = !usable(r) || !selected.includes(r.key) || !inPlot.has(r.key);
                      return (
                        <tr key={r.key} className={dim ? "dim" : ""}
                          title={[r.note, ...Object.entries(values[r.key] ?? {}).filter(([k]) => k !== "run").map(([k, v]) => `${k} = ${v}`)].filter(Boolean).join("\n") || undefined}>
                          <td><input type="checkbox" disabled={!usable(r)} checked={usable(r) && !prefs.deselected.includes(r.key)}
                            aria-label={`Include run ${r.number ?? r.key}`} onChange={() => toggleRun(r.key)} /></td>
                          <td className="mono">{r.number ?? (r.key === "wavedump" ? "-" : r.key)}</td>
                          {columns.map((c) => <td key={c} className="mono">{values[r.key]?.[c] ?? <span className="muted">-</span>}</td>)}
                          <td className="mono num">{r.events != null ? r.events.toLocaleString() : "-"}</td>
                          <td><span className={"ql-health " + h.cls} title={h.title}>{h.text}</span></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p className="muted ql-note">Dimmed runs are not in the plot: unticked, filtered out, or not readable yet. Click a facet to show it as a column; drag a column to move it.</p>
            </>
          ) : null}
        </div>

        {folder ? (
          <div className="card ql-card">
            <div className="ql-row-between"><h2>Channels</h2>
              <span className="ql-head-tools">
                <span className="muted">{inUseCh.length} of 16 in use</span>
                {channelsChanged ? <button className="mini" title="Every channel back to its own input, none struck"
                  onClick={() => { setPrefs((p) => ({ ...p, channels: defaultChannels() })); setChOpen(null); }}>Reset</button> : null}
              </span>
            </div>
            <div className="ql-chans">
              {prefs.channels.map((c, i) => (
                <div key={i} className={"ql-chcell" + (chOpen === i ? " pick" : "")}>
                  <button type="button" role="checkbox" aria-checked={!c.struck} aria-label={chLabel(i)}
                    className={"ql-ch" + (c.struck ? " off" : "") + (c.source !== `in:${i}` && !c.struck ? " sub" : "")}
                    title={c.struck ? "Struck - click to bring it back" : "In use - click to strike it from the analysis"}
                    {...paintProps("strike", !c.struck, (on) => setStruck(i, !on), paint)}>
                    <span className="mono">{i}</span>
                    <small>{c.source.startsWith("tr0") ? "TR0" : c.source !== `in:${i}` ? `in ${c.source.slice(3)}` : ""}</small>
                  </button>
                  <button type="button" className="ql-chmore" aria-label={`Source of ch ${i}…`} aria-expanded={chOpen === i}
                    title="Source" onClick={() => setChOpen(chOpen === i ? null : i)}>
                    <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden="true">
                      <path fillRule="evenodd" d="M9.92 4.79L11.48 4.83L11.48 7.17L9.92 7.21L9.63 7.91L10.70 9.05L9.05 10.70L7.91 9.63L7.21 9.92L7.17 11.48L4.83 11.48L4.79 9.92L4.09 9.63L2.95 10.70L1.30 9.05L2.37 7.91L2.08 7.21L0.52 7.17L0.52 4.83L2.08 4.79L2.37 4.09L1.30 2.95L2.95 1.30L4.09 2.37L4.79 2.08L4.83 0.52L7.17 0.52L7.21 2.08L7.91 2.37L9.05 1.30L10.70 2.95L9.63 4.09ZM7.7 6a1.7 1.7 0 1 0 -3.4 0a1.7 1.7 0 1 0 3.4 0Z" />
                    </svg>
                  </button>
                </div>
              ))}
            </div>
            {chOpen !== null ? <ChannelEditor ch={chOpen} setting={prefs.channels[chOpen]}
              onChange={(c) => setPrefs((p) => ({ ...p, channels: p.channels.map((x, i) => i === chOpen ? c : x) }))}
              onDone={() => setChOpen(null)} /> : null}
            <span className="muted">Click a channel to enable/disable it in the view and analysis. Saved data is never modified.</span>
          </div>
        ) : null}

        {folder ? (
          <div className="card ql-card">
            <div className="ql-row-between"><h2>Event selection</h2>
              {passFrac !== null ? <span className="mono ql-pass">{(passFrac * 100).toFixed(1)}% pass</span> : null}
            </div>
            <div className="ql-facets">
              <button className={"ql-slot filter" + (prefs.noClip ? "" : " off")} aria-pressed={prefs.noClip}
                title="Drop events where any channel in use touches the ADC rail"
                onClick={() => setPrefs((p) => ({ ...p, noClip: !p.noClip }))}>no clipping {prefs.noClip ? "✓" : ""}</button>
              {prefs.cuts.map((c, i) => cutEdit === i ? (
                <CutForm key={i} channels={prefs.channels} initial={c}
                  onDone={(next) => { setPrefs((p) => ({ ...p, cuts: p.cuts.map((x, k) => k === i ? next : x) })); closeCut(i); }}
                  onCancel={() => closeCut(i)} />
              ) : (
                <span key={i} className="ql-slot filter">
                  <button className="ql-chip-text" data-cut={i} aria-label={`Edit cut ${cutText(c)}`} title="Edit"
                    onClick={() => setCutEdit(i)}>{cutText(c)}</button>
                  <button className="ql-x" aria-label={`Remove cut ${cutText(c)}`}
                    onClick={() => { setPrefs((p) => ({ ...p, cuts: p.cuts.filter((_, k) => k !== i) })); setCutEdit(null); }}>×</button>
                </span>
              ))}
              {cutEdit === "new" ? <CutForm channels={prefs.channels}
                onDone={(c) => { setPrefs((p) => ({ ...p, cuts: [...p.cuts, c] })); closeCut(prefs.cuts.length); }}
                onCancel={() => { setCutEdit(null); requestAnimationFrame(() => document.querySelector<HTMLElement>(".ql-slot.add[data-add-cut]")?.focus()); }} />
                : <button className="ql-slot add" data-add-cut onClick={() => setCutEdit("new")}>+ cut</button>}
            </div>
            {passFrac !== null ? <div className="ql-bar"><div style={{ width: `${(passFrac * 100).toFixed(1)}%` }} /></div> : null}
            {result ? <span className="muted mono">{result.passed.toLocaleString()} of {result.events.toLocaleString()} events · applies to every plot</span> : null}
          </div>
        ) : null}
      </aside>

      <main className="ql-main">
        <div className="ql-recipes" role="tablist" aria-label="Analysis">
          {RECIPES.map((r) => (
            <button key={r.id} role="tab" aria-selected={spec.recipe === r.id} title={r.help}
              className={"ql-recipe" + (spec.recipe === r.id ? " on" : "")} onClick={() => setPlot({ recipe: r.id as Recipe })}>
              <RecipeIcon id={r.id} />{r.label}
            </button>
          ))}
        </div>

        <div className="card ql-card">
          <div className="ql-sentence">{sentence}</div>
          {tooMany ? <div className="ql-warn">{tooMany} more series not shown - filter, or split by fewer facets.</div> : null}
          {dropped && folder ? <div className="muted">{dropped} selected run{dropped === 1 ? " has" : "s have"} no value for {[...(kind === "facet" ? [xFacet] : []), ...seriesFacets].join(" or ")} and {dropped === 1 ? "is" : "are"} left out.</div> : null}

          {kind === "spatial" ? (
            <Spatial result={result} prefs={prefs} setPrefs={setPrefs} colorOf={colorOf} seriesLabel={seriesLabel} />
          ) : (
            <div className="ql-plot-row">
              <div className="ql-plot" ref={panelsRef}>
                {kind === "waveform" ? (
                  <Multiples panels={wavePanels ?? []} yMode={baselineOff ? "offset" : "shared"}
                    yLabel={baselineOff ? "average pulse, as recorded (mV)" : "average pulse, baseline removed (mV)"}
                    edit={{ proc, onCommit: (p) => setPrefs((q) => ({ ...q, processing: p })),
                            refs: seriesNames.filter((n) => !winCol || showWin(n)).map((n) => ({
                              t0: result?.ref_t0?.[n] ?? null, color: seriesNames.length > 1 ? colorOf(n) : "#58a6ff" })) }}
                    empty={!waveChannels.length && folder ? "No channels picked." : emptyText} />
                ) : chart ? <Chart ref={chartRef} {...chart}
                  empty={!selected.length ? "Select some runs." : !groups.length ? "No runs match." : "Reading…"} />
                  : <div className="ql-chart-empty muted">{emptyText}</div>}
              </div>
              <div className="ql-legend-col">
                {hasLegend ? (
                  <div className="ql-legend" aria-label="Legend">
                    {seriesFacets.length || winCol ? (
                      <div className="ql-legend-row head">
                        <span className="muted">{seriesFacets.join(SERIES_SEP)}</span>
                        {winCol ? <span className="muted" title="Draw this series' integration window. Drag down the column to set several.">window</span> : null}
                      </div>
                    ) : null}
                    {seriesNames.map((s) => {
                      const n = new Set(groups.filter((g) => g.series === s).flatMap((g) => g.runs)).size;
                      const hs = plot?.series.find((x) => x.name === s);
                      return (
                        <div key={s} className="ql-legend-row">
                          <span><span className="ql-sw" style={{ background: colorOf(s) }} />{seriesFacets.length ? s : "all"}
                            {n > 1 ? <span className="muted"> · {n} runs</span> : null}
                            {kind === "hist" && hs?.stats ? <span className="muted mono ql-legend-stat">μ {fmt(hs.stats.mean)} · σ {fmt(hs.stats.core_sigma)}</span> : null}
                            {kind === "facet" && hs?.fit ? <span className="muted mono ql-legend-stat">a {fmt(hs.fit.a * 100, 2)}% · b {fmt(hs.fit.b * 100, 2)}% · c {fmt(hs.fit.c * 100, 2)}%</span> : null}
                          </span>
                          {winCol ? <PaintCheck checked={showWin(s)} label={`Window for ${s}`} paint={paint}
                            onSet={(v) => setWin(s, v)} /> : null}
                        </div>
                      );
                    })}
                  </div>
                ) : null}
                {hasErr ? (
                  <label className="ql-field">Error bars
                    <select aria-label="Error bars" value={spec.err}
                      onChange={(e) => setPlot({ err: e.target.value as PlotSpec["err"] })}>
                      <option value="rms">RMS (spread)</option><option value="sem">SEM (of the mean)</option><option value="none">none</option>
                    </select>
                  </label>
                ) : null}
                <div className="ql-actions">
                  <button className="mini" disabled={!plot} onClick={csv}>Download CSV</button>
                  <button className="mini" disabled={kind === "waveform" ? !hasLegend : !chart} onClick={png}>Download PNG</button>
                  <button className="mini" disabled={!folder} title="Channels, facets, processing and cuts, as a file you can load again or hand to someone" onClick={exportSettings}>Export settings</button>
                </div>
              </div>
            </div>
          )}
          {kind === "spatial" ? (
            <div className="ql-actions row">
              <button className="mini" disabled={!plot} onClick={csv}>Download CSV</button>
              <button className="mini" disabled={!folder} onClick={exportSettings}>Export settings</button>
            </div>
          ) : null}
          {/* Every plot integrates, so what it integrates is always in view:
              one line here, the windows themselves on the Waveforms pulses. */}
          {folder ? (
            <div className="ql-strip">
              <div className="ql-strip-head">
                <button className="ql-collapse" aria-expanded={procOpen} aria-controls="ql-proc-body"
                  onClick={() => setProcOpen(!procOpen)}>
                  <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M3 1.5L6.5 5 3 8.5" fill="none" stroke="currentColor" strokeWidth="1.5" /></svg>
                  Processing</button>
                <span className="muted">{procSummary(proc)}</span>
                <span className="ql-grow" />
                {kind === "waveform" ? <span className="muted">Drag the shaded windows on any channel; they apply to all.</span>
                  : <button className="linkish" onClick={() => setPlot({ recipe: "waveform" })}>Set the windows on the pulses</button>}
              </div>
              {refMissing.length ? <div className="ql-warn">No pulse found on the reference channel{seriesFacets.length ? ` for ${refMissing.join(", ")}` : ""}, so the integration window cannot be placed.</div> : null}
              {procOpen ? <div id="ql-proc-body"><ProcessingFields prefs={prefs} setPrefs={setPrefs} /></div> : null}
            </div>
          ) : null}
          <span className={"muted ql-status" + (busy && !pg?.done ? " busy" : "")}>{status}</span>
        </div>
      </main>

      {facetDialog && folder ? (
        <FacetBuilder runs={runs} initial={facetDialog.def} overrides={prefs.overrides}
          taken={facets.map((t) => t.name)}
          onClose={() => setFacetDialog(null)}
          onDelete={(name) => {
            setPrefs((p) => ({ ...p, facets: p.facets.filter((t) => t.name !== name),
              overrides: Object.fromEntries(Object.entries(p.overrides).map(([k, v]) => {
                const { [name]: _, ...rest } = v; return [k, rest];
              })) }));
            setFacetDialog(null);
          }}
          onSave={(def, fixes, oldName) => {
            setPrefs((p) => {
              const facetsNext = oldName ? p.facets.map((t) => t.name === oldName ? def : t) : [...p.facets, def];
              const ov: FolderPrefs["overrides"] = {};
              for (const [k, v] of Object.entries(p.overrides)) {
                const { [oldName ?? def.name]: _, ...rest } = v;
                ov[k] = rest;
              }
              for (const [k, v] of Object.entries(fixes)) ov[k] = { ...(ov[k] ?? {}), [def.name]: v };
              const ren = (n: string) => (n === oldName ? def.name : n);
              const renamed = oldName && oldName !== def.name;
              const plotNext = renamed ? {
                ...p.plot,
                seriesFacets: p.plot.seriesFacets.map(ren),
                xFacet: ren(p.plot.xFacet),
                filters: p.plot.filters.map((f) => ({ ...f, facet: ren(f.facet) })),
              } : p.plot;
              const columnsNext = renamed && p.columns ? p.columns.map(ren) : p.columns;
              return { ...p, facets: facetsNext, overrides: ov, plot: plotNext, columns: columnsNext };
            });
            setFacetDialog(null);
          }} />
      ) : null}
    </div>
  );
}

/** A drag in progress: the value being painted, which group of toggles it
 *  paints, and where the pointer last was. */
interface PaintState { value: boolean; group: string; x: number; y: number }
type Paint = React.MutableRefObject<PaintState | null>;

/** Each paintable toggle's setter, found again from the element under the
 *  pointer. */
const painters = new WeakMap<Element, (v: boolean) => void>();

/** Handlers for a toggle that can be painted: press one to flip it, keep
 *  the button down and every toggle of the same `group` passed over takes
 *  that same value (set, never inverted). Space/Enter toggle from the
 *  keyboard as usual. `onSet` must update state functionally - a drag sets
 *  several before React re-renders. */
function paintProps(group: string, checked: boolean, onSet: (v: boolean) => void, paint: Paint) {
  return {
    "data-paint": group,
    "data-on": String(checked),
    ref: (el: HTMLElement | null) => { if (el) painters.set(el, onSet); },
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
      if (e.button !== 0) return;
      e.preventDefault();                                   // no text selection while dragging
      e.currentTarget.releasePointerCapture?.(e.pointerId); // touch: let the others see the pointer
      paint.current = { value: !checked, group, x: e.clientX, y: e.clientY };
      onSet(!checked);
    },
    onClick: (e: React.MouseEvent) => { if (e.detail === 0) onSet(!checked); },
  };
}

/** Paint every toggle of the group along the pointer's path since its last
 *  position. Moves arrive once a frame, so a quick flick would otherwise
 *  skip the toggles it crossed between two frames. */
function paintAlong(p: PaintState, x: number, y: number) {
  const steps = Math.max(1, Math.ceil(Math.hypot(x - p.x, y - p.y) / 4));
  const seen = new Set<Element>();
  for (let k = 1; k <= steps; k++) {
    const el = document.elementFromPoint(p.x + (x - p.x) * k / steps, p.y + (y - p.y) * k / steps)
      ?.closest(`[data-paint="${p.group}"]`);
    if (!el || seen.has(el)) continue;
    seen.add(el);
    if (el.getAttribute("data-on") !== String(p.value)) painters.get(el)?.(p.value);
  }
  p.x = x; p.y = y;
}

function PaintCheck({ checked, label, paint, onSet }: {
  checked: boolean; label: string; paint: Paint; onSet: (v: boolean) => void;
}) {
  return (
    <button type="button" role="checkbox" aria-checked={checked} aria-label={label}
      className={"ql-paint" + (checked ? " on" : "")} {...paintProps("window", checked, onSet, paint)}>
      <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
        {checked ? <path d="M2 5.2l2 2L8 3" fill="none" stroke="currentColor" strokeWidth="1.6" /> : null}
      </svg>
    </button>
  );
}

function RecipeIcon({ id }: { id: Recipe }) {
  const d: Record<Recipe, JSX.Element> = {
    waveform: <path d="M1 10h3l2-6 3 10 2-4h6" />,
    hist: <path d="M2 16V12M6 16V6M10 16V3M14 16V9" />,
    channel: <><path d="M2 13l4-5 3 3 3-7 4 6" /><circle cx="6" cy="8" r="1.3" /><circle cx="12" cy="4" r="1.3" /></>,
    facet: <><path d="M2 16L16 2" /><circle cx="5" cy="13" r="1.3" /><circle cx="9" cy="9" r="1.3" /><circle cx="13" cy="5" r="1.3" /></>,
    resolution: <path d="M2 3c2 9 6 12 14 12" />,
    spatial: <><rect x="2" y="2" width="14" height="14" rx="1.5" /><path d="M2 9h14M9 2v14" /></>,
  };
  return <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">{d[id]}</svg>;
}

/** One channel's source. Its own TR0 is the copy digitized in its bank -
 *  on its own time axis - so that is the one offered. */
function ChannelEditor({ ch, setting, onChange, onDone }: {
  ch: number; setting: FolderPrefs["channels"][number];
  onChange: (c: FolderPrefs["channels"][number]) => void; onDone: () => void;
}) {
  const tr0 = bankTr0(ch);
  const otherTr0 = setting.source.startsWith("tr0:") && setting.source !== tr0;
  return (
    <div className="ql-pop" onKeyDown={(e) => { if (e.key === "Escape") onDone(); }}>
      <b>ch {ch}</b>
      <label className="ql-row-between">Source
        <select aria-label={`Source of ch ${ch}`} value={setting.source} autoFocus
          onChange={(e) => onChange({ ...setting, source: e.target.value })}>
          <option value={`in:${ch}`}>input {ch}</option>
          <option value={tr0}>TR0</option>
          {otherTr0 ? <option value={setting.source}>TR0 (other bank's copy)</option> : null}
          {Array.from({ length: N_CH }, (_, k) => k).filter((k) => k !== ch).map((k) => (
            <option key={k} value={`in:${k}`}>input {k}</option>
          ))}
        </select>
      </label>
      {setting.source.startsWith("tr0") ? (
        <span className="muted">TR0 has its own ×2 attenuator; values are converted to input volts so ch {ch} compares with its neighbours. Its noise in input volts is about twice theirs.</span>
      ) : null}
      <div className="ql-pop-btns"><button className="mini" onClick={onDone}>Done</button></div>
    </div>
  );
}

function FilterForm({ facetNames, valuesOf, onAdd, onCancel }: {
  facetNames: string[]; valuesOf: (facet: string) => string[];
  onAdd: (f: Filter) => void; onCancel: () => void;
}) {
  const [facet, setFacet] = useState(facetNames.find((t) => t !== "run") ?? facetNames[0] ?? "run");
  const vals = valuesOf(facet);
  const [val, setVal] = useState(vals[0] ?? "");
  const v = vals.includes(val) ? val : (vals[0] ?? "");
  return (
    <span className="ql-inline-form" onKeyDown={(e) => {
      if (e.key === "Escape") onCancel();
      else if (e.key === "Enter" && vals.length) onAdd({ facet, value: v });
    }}>
      <select aria-label="Filter facet" value={facet} autoFocus onChange={(e) => setFacet(e.target.value)}>
        {facetNames.map((t) => <option key={t}>{t}</option>)}
      </select>
      <span>=</span>
      <select aria-label="Filter value" value={v} onChange={(e) => setVal(e.target.value)}>
        {vals.map((x) => <option key={x}>{x}</option>)}
      </select>
      <button className="mini primary" disabled={!vals.length} onClick={() => onAdd({ facet, value: v })}>Add</button>
      <button className="mini" onClick={onCancel}>Cancel</button>
    </span>
  );
}

function cutText(c: Cut): string {
  const range = c.min !== null && c.max !== null ? `${c.min}–${c.max}` : c.min !== null ? `≥ ${c.min}` : `≤ ${c.max}`;
  return `${c.channel === "sum" ? "Σ" : `ch ${c.channel}`} ${c.quantity} ${range} ${UNIT[c.quantity]}`;
}

/** A new cut, or an existing one edited where its chip was. Enter applies,
 *  Escape cancels; a bound that is not a number, or min above max, holds
 *  Apply back and says so on the field. */
function CutForm({ channels, initial, onDone, onCancel }: {
  channels: FolderPrefs["channels"]; initial?: Cut; onDone: (c: Cut) => void; onCancel: () => void;
}) {
  const [quantity, setQuantity] = useState<Quantity>(initial?.quantity ?? "charge");
  const [channel, setChannel] = useState<ChanSel>(initial?.channel ?? "sum");
  const [min, setMin] = useState(initial?.min != null ? String(initial.min) : "");
  const [max, setMax] = useState(initial?.max != null ? String(initial.max) : "");
  const n = (s: string) => (s.trim() === "" || !isFinite(Number(s)) ? null : Number(s));
  const bad = (s: string) => s.trim() !== "" && n(s) === null;
  const lo = n(min), hi = n(max);
  const crossed = lo !== null && hi !== null && lo > hi;
  const ok = (lo !== null || hi !== null) && !bad(min) && !bad(max) && !crossed;
  const apply = () => { if (ok) onDone({ quantity, channel, min: lo, max: hi }); };
  return (
    <span className="ql-cutform" role="group" aria-label={initial ? "Edit cut" : "New cut"}
      onKeyDown={(e) => {
        if (e.key === "Escape") { e.stopPropagation(); onCancel(); }
        else if (e.key === "Enter") { e.preventDefault(); apply(); }
      }}>
      <select aria-label="Cut channel" value={String(channel)} autoFocus
        onChange={(e) => setChannel(e.target.value === "sum" ? "sum" : Number(e.target.value))}>
        {quantity === "charge" ? <option value="sum">Σ all channels</option> : null}
        {channels.map((c, i) => <option key={i} value={i} disabled={c.struck}>ch {i}</option>)}
      </select>
      <select aria-label="Cut quantity" value={quantity} onChange={(e) => {
        const q = e.target.value as Quantity; setQuantity(q); if (q !== "charge" && channel === "sum") setChannel(0);
      }}>
        {QUANTITIES.map((q) => <option key={q}>{q}</option>)}
      </select>
      <input aria-label="Minimum" placeholder="min" value={min} onChange={(e) => setMin(e.target.value)}
        aria-invalid={bad(min) || crossed} title={bad(min) ? "Not a number" : crossed ? "Above the maximum" : undefined} />
      <input aria-label="Maximum" placeholder="max" value={max} onChange={(e) => setMax(e.target.value)}
        aria-invalid={bad(max) || crossed} title={bad(max) ? "Not a number" : crossed ? "Below the minimum" : undefined} />
      <span className="muted">{UNIT[quantity]}</span>
      <button className="mini primary" disabled={!ok} onClick={apply}>{initial ? "Apply" : "Add"}</button>
      <button className="mini" onClick={onCancel}>Cancel</button>
    </span>
  );
}

function NumField({ value, onCommit, label, step = 0.5 }: { value: number; onCommit: (v: number) => void; label: string; step?: number }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const commit = () => { const v = Number(text); if (text.trim() !== "" && isFinite(v)) onCommit(v); else setText(String(value)); };
  return <input className="mono ql-num" aria-label={label} value={text} step={step}
    onChange={(e) => setText(e.target.value)} onBlur={commit}
    onKeyDown={(e) => { if (e.key === "Enter") commit(); }} />;
}

function SourceOptions() {
  return (
    <>
      <option value="tr0:0">TR0 (group 0 copy)</option>
      <option value="tr0:1">TR0 (group 1 copy)</option>
      {Array.from({ length: N_CH }, (_, i) => <option key={i} value={`in:${i}`}>input {i}</option>)}
    </>
  );
}

/** The settings in one line, for the collapsed Processing card. */
function procSummary(p: ProcPrefs): string {
  const r = (a: [number, number]) => `${fmt(a[0])}–${fmt(a[1])} ns`;
  const base = p.baselineOn ? `baseline ${r(p.baseline)} subtracted` : "no baseline subtraction";
  const win = p.window.mode === "all" ? "whole record integrated"
    : p.window.mode === "reference" ? `integrated ${r(p.window.range)} from ${sourceLabel(p.window.reference ?? "tr0:0")}`
    : `integrated ${r(p.window.range)}`;
  return `${base} · ${win}`;
}

function ProcessingFields({ prefs, setPrefs }: {
  prefs: FolderPrefs; setPrefs: (fn: (p: FolderPrefs) => FolderPrefs) => void;
}) {
  const p = prefs.processing;
  const setProc = (q: Partial<ProcPrefs>) => setPrefs((x) => ({ ...x, processing: { ...x.processing, ...q } }));
  const setWin = (w: Partial<ProcPrefs["window"]>) => setProc({ window: { ...p.window, ...w } });
  return (
    <div className="ql-proc-fields">
      <div className="ql-step"><label htmlFor="ql-base">Baseline subtraction</label>
        <span>
          <select id="ql-base" value={p.baselineOn ? "mean" : "none"} onChange={(e) => setProc({ baselineOn: e.target.value === "mean" })}>
            <option value="mean">mean of</option><option value="none">none</option>
          </select>
          {p.baselineOn ? <>{" "}<NumField label="Baseline from (ns)" value={p.baseline[0]} onCommit={(v) => setProc({ baseline: [v, p.baseline[1]] })} />
            {" "}– <NumField label="Baseline to (ns)" value={p.baseline[1]} onCommit={(v) => setProc({ baseline: [p.baseline[0], v] })} /> ns, per event</> : null}
        </span></div>
      <div className="ql-step"><label htmlFor="ql-win">Integrate</label>
        <span>
          <select id="ql-win" value={p.window.mode} onChange={(e) => {
            const mode = e.target.value as ProcPrefs["window"]["mode"];
            setWin(mode === "reference" ? { mode, reference: p.window.reference ?? "tr0:0", range: [-5, 45] }
              : mode === "record" ? { mode, range: [60, 120] } : { mode });
          }}>
            <option value="record">fixed window</option><option value="reference">from a reference pulse</option>
            <option value="all">the whole record</option>
          </select>
          {p.window.mode === "reference" ? (
            <>{" "}<select aria-label="Integration reference" value={p.window.reference ?? "tr0:0"} onChange={(e) => setWin({ reference: e.target.value })}><SourceOptions /></select>
              {" "}at <NumField label="Reference fraction (%)" step={5} value={Math.round(p.cfd * 100)}
                onCommit={(v) => setProc({ cfd: Math.min(95, Math.max(5, v)) / 100 })} />% of its peak,</>
          ) : null}
          {p.window.mode !== "all" ? <>{" "}<NumField label="Integrate from (ns)" value={p.window.range[0]} onCommit={(v) => setWin({ range: [v, p.window.range[1]] })} />
            {" "}– <NumField label="Integrate to (ns)" value={p.window.range[1]} onCommit={(v) => setWin({ range: [p.window.range[0], v] })} /> ns</> : null}
        </span></div>
      <p className="muted">One set for the whole folder; changing it rereads the runs. Charge and amplitude
        count positive whichever way a channel's pulses go. From a reference pulse, each event's window starts
        where that pulse crosses the fraction of its peak - wherever the trigger put it in the record.</p>
    </div>
  );
}

function Spatial({ result, prefs, setPrefs, colorOf, seriesLabel }: {
  result: Analysis | null; prefs: FolderPrefs; setPrefs: (fn: (p: FolderPrefs) => FolderPrefs) => void;
  colorOf: (s: string) => string; seriesLabel: (s: string) => string;
}) {
  const plot = result?.plot.kind === "spatial" ? result.plot : null;
  const rows = 4, cols = 4;
  const maxShare = Math.max(0.01, ...(plot?.series ?? []).flatMap((s) => (s.cells ?? []).map((c) => c.share ?? 0)));
  const shade = (f: number) => {
    const t = Math.max(0, Math.min(1, f / maxShare));
    const m = (a: number, b: number) => Math.round(a + (b - a) * t);
    return { background: `rgb(${m(26, 108)},${m(36, 182)},${m(51, 255)})`, color: t > 0.55 ? "#0b1320" : "#c9d1d9" };
  };
  const preset = (kind: "row" | "col") => setPrefs((p) => ({
    ...p, pixels: Array.from({ length: 16 }, (_, i) => kind === "row" ? i : (i % 4) * 4 + Math.floor(i / 4)),
  }));
  return (
    <div className="ql-spatial">
      <div className="ql-maps">
        {(plot?.series ?? []).map((s) => (
          <figure key={s.name} className="ql-map-fig">
            <figcaption><span className="ql-sw" style={{ background: colorOf(s.name) }} />{seriesLabel(s.name)}</figcaption>
            <div className="ql-map" role="img" aria-label={`Charge share per pixel, ${seriesLabel(s.name)}`}>
              {(s.cells ?? []).map((c, i) => {
                const struck = c.channel >= 0 && prefs.channels[c.channel]?.struck;
                return c.channel < 0 || struck || c.share == null ? (
                  <div key={i} className="ql-cell off"><span className="mono">-</span><small>{c.channel >= 0 ? `ch${c.channel} off` : "none"}</small></div>
                ) : (
                  <div key={i} className={"ql-cell" + (c.share < 0 ? " neg" : "")}
                    style={c.share < 0 ? undefined : shade(c.share)}
                    title={c.share < 0 ? "Negative mean charge: the baseline or integration window does not fit this channel's pulse" : undefined}>
                    <span className="mono">{Math.round(c.share * 100)}%</span>
                    <small className="mono">ch{c.channel}{prefs.channels[c.channel].source.startsWith("tr0") ? "·TR0" : ""}</small>
                  </div>
                );
              })}
              {s.centroid ? <div className="ql-centroid" aria-hidden="true" style={{
                left: `${((s.centroid.x / (plot!.pitch || 1) + (cols - 1) / 2) + 0.5) / cols * 100}%`,
                top: `${(((rows - 1) / 2 - s.centroid.y / (plot!.pitch || 1)) + 0.5) / rows * 100}%`,
              }} /> : null}
            </div>
            <span className="muted mono" title="The share-weighted centre of the map: with charge on both sides of a weak row it lands in that row. Spread: how far single events' centroids scatter around it.">
              {s.centroid ? `centroid (${fmt(s.centroid.x, 2)}, ${fmt(s.centroid.y, 2)}) mm · spread ${fmt(s.centroid.sx, 2)} × ${fmt(s.centroid.sy, 2)}` : "no events"}</span>
          </figure>
        ))}
        {!plot?.series.length ? <div className="ql-chart-empty muted">Reading…</div> : null}
      </div>
      <div className="ql-layout">
        <h2>Pixel layout</h2>
        <label className="ql-field">Preset
          <select value="" onChange={(e) => { if (e.target.value) preset(e.target.value as "row" | "col"); }}>
            <option value="">choose…</option>
            <option value="row">4 × 4, row-major from top-left</option>
            <option value="col">4 × 4, column-major from top-left</option>
          </select>
        </label>
        <span className="muted">The channel each pixel shows, as seen from the beam (-1 = none).</span>
        <div className="ql-pixgrid">
          {prefs.pixels.map((ch, i) => (
            <NumField key={i} step={1} label={`Pixel row ${Math.floor(i / 4) + 1} column ${(i % 4) + 1}`} value={ch}
              onCommit={(v) => setPrefs((p) => ({ ...p, pixels: p.pixels.map((x, k) => k === i ? Math.round(Math.max(-1, Math.min(15, v))) : x) }))} />
          ))}
        </div>
        <label className="ql-row-between">Pixel pitch <span><NumField label="Pixel pitch (mm)" value={prefs.pitch} step={0.1}
          onCommit={(v) => setPrefs((p) => ({ ...p, pitch: v > 0 ? v : p.pitch }))} /> mm</span></label>
        <p className="muted">This view only; nothing is written to the data. Export settings to reuse it. Struck pixels drop out of the centroid, which then leans away from them.</p>
      </div>
    </div>
  );
}
