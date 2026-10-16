import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePersistentState } from "../persist";
import { qlApi } from "./api";
import type { Analysis, ChanSel, Cut, Processing, QlFolder, QlFolderEntry, QlRun, Quantity } from "./types";
import {
  N_CH, RECIPES, SERIES_COLORS, UNIT, allTags, defaultPrefs, makeGroups, sanitize, sourceLabel,
  tagValues, type Filter, type FolderPrefs, type PlotSpec, type Recipe, type TagDef,
} from "./model";
import { Chart, download, exportPng, fmt, type ChartSeries, type Tick } from "./Chart";
import { Pulse } from "./Pulse";
import { TagBuilder } from "./TagBuilder";

/** Quick Look: preliminary analysis of recorded runs, for the "do we need
 *  to rerun anything?" check before leaving. Strictly read-only: every
 *  setting here (tags, channel map, cuts) is this view's, kept in the
 *  browser; the data files are never touched. Exports are downloads. */

const QUANTITIES: Quantity[] = ["charge", "amplitude", "time", "pedestal", "noise"];
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
  const [tagDialog, setTagDialog] = useState<{ def: TagDef | null } | null>(null);
  const [chOpen, setChOpen] = useState<number | null>(null);
  const [addCut, setAddCut] = useState(false);
  const [addFilter, setAddFilter] = useState(false);
  const chartRef = useRef<SVGSVGElement | null>(null);

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
  const tags = useMemo(() => allTags(runs, prefs.tags), [runs, prefs.tags]);
  const values = useMemo(() => tagValues(runs, prefs.tags, prefs.overrides),
    [runs, prefs.tags, prefs.overrides]);
  const tagNames = ["run", ...tags.map((t) => t.name)];
  const numericTags = ["run", ...tags.filter((t) => t.kind === "number").map((t) => t.name)];

  const spec = prefs.plot;
  const recipe = RECIPES.find((r) => r.id === spec.recipe) ?? RECIPES[2];
  const kind = recipe.kind;
  const xTag = numericTags.includes(spec.xTag) ? spec.xTag
    : (numericTags.find((t) => t !== "run") ?? "run");
  const effSpec: PlotSpec = { ...spec, xTag, seriesTag: spec.seriesTag === xTag && kind === "tag" ? "" : spec.seriesTag };
  const { groups, dropped, tooMany } = useMemo(
    () => makeGroups(selected, values, effSpec, kind),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [JSON.stringify(selected), values, JSON.stringify(effSpec), kind]);
  const seriesNames = [...new Set(groups.map((g) => g.series))];
  const colorOf = (s: string) => SERIES_COLORS[seriesNames.indexOf(s)] ?? SERIES_COLORS[0];
  const seriesLabel = (s: string) => effSpec.seriesTag ? `${effSpec.seriesTag} = ${s}` : "all selected runs";

  // ---- the request: rebuilt from state, sent when it changes, re-polled while passes run ----
  const stat = spec.recipe === "resolution" ? "resolution" : spec.stat;
  const channelForPlot: ChanSel = spec.channel === "sum" && spec.quantity !== "charge" ? 0 : spec.channel;
  const req = folder ? {
    folder: folderId, runs: selected, processing: prefs.processing, channels: prefs.channels,
    polarity: prefs.polarity, timing_ref: prefs.timingRef, cuts: prefs.cuts, no_clip: prefs.noClip,
    plot: { kind, quantity: spec.quantity, stat, err: spec.err, channel: channelForPlot,
            fit: spec.fit, pixels: prefs.pixels, pitch: prefs.pitch, rows: 4, cols: 4 },
    groups, pulse_channel: spec.pulseChannel,
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
  const chLabel = (i: number) => {
    const c = prefs.channels[i];
    return c.struck ? `ch ${i} (struck)` : c.source !== `in:${i}` ? `ch ${i} · ${c.source.startsWith("tr0") ? "TR0" : sourceLabel(c.source)}` : `ch ${i}`;
  };
  const inUse = prefs.channels.filter((c) => !c.struck && c.source !== "off").length;

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
  // Two tag columns fit beside the run checks: the ones this plot uses
  // first, then tags read from the notes, then the metadata's.
  const used = [effSpec.seriesTag, kind === "tag" ? xTag : "", ...spec.filters.map((f) => f.tag)];
  const rank = (t: { name: string; source: string }) =>
    (used.includes(t.name) ? 0 : t.source === "meta" ? 2 : 1);
  const tableTags = [...tags].sort((a, b) => rank(a) - rank(b)).slice(0, 2);
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
    } else if (kind === "tag") {
      chart = {
        xLabel: xTag, yLabel: stat === "resolution" ? `σ/mean of ${spec.quantity}` : `${statWord} ${spec.quantity} (${unit})`,
        zeroY: true,
        series: plot.series.map((s) => ({
          name: seriesLabel(s.name), color: colorOf(s.name), line: true,
          fit: s.fit?.curve,
          points: (s.points ?? []).map((p) => ({
            x: p.x ?? NaN, y: p.y ?? NaN, err: p.err ?? null,
            tip: <>
              <span>{xTag} = {fmt(p.x)}</span>
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
      chart = {
        xLabel: "time (ns)", yLabel: "average pulse, baseline removed (mV)",
        series: plot.series.map((s) => ({
          name: seriesLabel(s.name), color: colorOf(s.name), line: true, markers: false,
          points: (s.t ?? []).map((t, i) => ({ x: t, y: (s.v ?? [])[i] })),
        })),
      };
    }
  }

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
    } else if (kind === "tag") {
      rows.push(["series", xTag, "y", "err", "n", "runs"]);
      for (const s of plot.series) for (const p of s.points ?? []) {
        rows.push([s.name, String(p.x), String(p.y ?? ""), String(p.err ?? ""), String(p.n ?? ""), (p.runs ?? []).map(runName).join(" ")]);
      }
    } else if (kind === "hist") {
      rows.push(["series", "bin_lo", "bin_hi", "count"]);
      for (const s of plot.series) (s.counts ?? []).forEach((c, i) => rows.push([s.name, String(plot.edges![i]), String(plot.edges![i + 1]), String(c)]));
    } else if (kind === "waveform") {
      rows.push(["series", "t_ns", "mV"]);
      for (const s of plot.series) (s.t ?? []).forEach((t, i) => rows.push([s.name, String(t), String((s.v ?? [])[i])]));
    } else if (kind === "spatial") {
      rows.push(["series", "pixel", "channel", "share"]);
      for (const s of plot.series) (s.cells ?? []).forEach((c, i) => rows.push([s.name, String(i), String(c.channel), String(c.share ?? "")]));
    }
    const text = rows.map((r) => r.map((c) => /[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c).join(",")).join("\n");
    download(new Blob([text + "\n"], { type: "text/csv" }), `${base}.csv`);
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
  const seriesSelect = (exclude?: string) => (
    <select className="ql-slot" aria-label="One series per" value={effSpec.seriesTag}
      onChange={(e) => setPlot({ seriesTag: e.target.value })}>
      <option value="">nothing (one series)</option>
      {tagNames.filter((t) => t !== exclude).map((t) => <option key={t} value={t}>{t}</option>)}
    </select>
  );
  const qSelect = (only?: Quantity[]) => (
    <select className="ql-slot" aria-label="Quantity" value={spec.quantity}
      onChange={(e) => setPlot({ quantity: e.target.value as Quantity })}>
      {(only ?? QUANTITIES).map((q) => <option key={q} value={q}>{q}</option>)}
    </select>
  );
  const statSelect = () => (
    <select className="ql-slot" aria-label="Statistic" value={spec.stat}
      onChange={(e) => setPlot({ stat: e.target.value as PlotSpec["stat"] })}>
      <option value="mean">mean</option><option value="median">median</option><option value="sigma">σ (core)</option>
    </select>
  );
  const xSelect = () => (
    <select className="ql-slot" aria-label="X axis tag" value={xTag} onChange={(e) => setPlot({ xTag: e.target.value })}>
      {numericTags.map((t) => <option key={t} value={t}>{t}</option>)}
    </select>
  );
  const valuesOf = (tag: string) => [...new Set(Object.values(values).map((v) => v[tag]).filter((v) => v !== undefined))]
    .sort((a, b) => (isFinite(+a) && isFinite(+b) ? +a - +b : a.localeCompare(b)));
  const filters = () => (
    <>
      {spec.filters.length ? <span>, where</span> : null}
      {spec.filters.map((f, i) => (
        <span key={i} className="ql-slot filter">{f.tag} = {f.value}
          <button className="ql-x" aria-label={`Remove filter ${f.tag} = ${f.value}`}
            onClick={() => setPlot({ filters: spec.filters.filter((_, k) => k !== i) })}>×</button>
        </span>
      ))}
      {addFilter ? <FilterForm tagNames={tagNames} valuesOf={valuesOf}
        onAdd={(f) => { setPlot({ filters: [...spec.filters, f] }); setAddFilter(false); }}
        onCancel={() => setAddFilter(false)} /> : (
        <button className="ql-slot add" onClick={() => setAddFilter(true)}>+ where</button>
      )}
    </>
  );
  // Error bars sit with the legend, not in the sentence: they qualify the
  // marks, and the sentence stays one line.
  const hasErr = (kind === "channel" || kind === "tag") && spec.recipe !== "resolution" && spec.stat !== "sigma";

  const sentence = (() => {
    const sumOk = spec.quantity === "charge";
    switch (spec.recipe) {
      case "waveform": return <>Average pulse on {plotChan(false)}, one line per {seriesSelect()}{filters()}</>;
      case "hist": return <>Histogram of {qSelect()} on {plotChan(sumOk)}, one line per {seriesSelect()}{filters()}</>;
      case "channel": return <>Plot {statSelect()} {qSelect()} vs channel, one series per {seriesSelect()}{filters()}</>;
      case "tag": return <>Plot {statSelect()} {qSelect()} on {plotChan(sumOk)} vs {xSelect()}, one series per {seriesSelect(xTag)}{filters()}</>;
      case "resolution": return <>Resolution (σ/mean) of {qSelect(["charge", "amplitude"])} on {plotChan(sumOk)} vs {xSelect()}, one series per {seriesSelect(xTag)}{filters()}<span className="ql-grow" />
        <label className="ql-check"><input type="checkbox" checked={spec.fit} onChange={(e) => setPlot({ fit: e.target.checked })} /> fit a/√x ⊕ b ⊕ c/x</label></>;
      case "spatial": return <>Share of charge per pixel, one map per {seriesSelect()}{filters()}</>;
    }
  })();

  // ---- status line ----
  const pg = result?.progress;
  const status = !folder ? "" : !selected.length ? "No runs selected." : !pg ? "Starting…"
    : pg.done ? `Computed on ${pg.total} run${pg.total === 1 ? "" : "s"} · ${result!.events.toLocaleString()} events, at low priority - the readout is not affected.${pg.errors ? ` ${pg.errors} could not be read.` : ""}`
    : `Preview from the first events of each run · full pass ${Math.round(pg.frac * 100)}% (${pg.full} of ${pg.total} runs done)`;

  const passFrac = result && result.events ? result.passed / result.events : null;

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
              <div className="ql-tags">
                <span className="muted">Tags</span>
                {tags.map((t) => t.source === "meta" ? (
                  <span key={t.name} className="ql-chip" title="From the Experiment Conditions in each run's metadata">{t.name} <span className="src">meta</span></span>
                ) : (
                  <button key={t.name} className="ql-chip" title={t.source === "folder" ? "Read from the run folder names - click to edit" : "Read from the run notes - click to edit"}
                    onClick={() => setTagDialog({ def: prefs.tags.find((d) => d.name === t.name) ?? null })}>{t.name} <span className="src">{t.source === "folder" ? "run folder" : "note"}</span></button>
                ))}
                <button className="mini dashed" onClick={() => setTagDialog({ def: null })}>+ Tag from name</button>
              </div>
              <div className="ql-table-wrap">
                <table className="ql-table">
                  <thead><tr>
                    <th><input type="checkbox" aria-label="Select all runs" checked={allChecked}
                      onChange={() => setPrefs((p) => ({ ...p, deselected: allChecked ? runs.filter(usable).map((r) => r.key) : [] }))} /></th>
                    <th>Run</th>
                    {tableTags.map((t) => <th key={t.name}>{t.name}</th>)}
                    <th className="num">events</th><th>check</th>
                  </tr></thead>
                  <tbody>
                    {runs.map((r) => {
                      const h = health(r);
                      const dim = !usable(r) || (selected.includes(r.key) && !inPlot.has(r.key));
                      return (
                        <tr key={r.key} className={dim ? "dim" : ""}
                          title={[r.note, ...Object.entries(values[r.key] ?? {}).filter(([k]) => k !== "run").map(([k, v]) => `${k} = ${v}`)].filter(Boolean).join("\n") || undefined}>
                          <td><input type="checkbox" disabled={!usable(r)} checked={usable(r) && !prefs.deselected.includes(r.key)}
                            aria-label={`Include run ${r.number ?? r.key}`} onChange={() => toggleRun(r.key)} /></td>
                          <td className="mono">{r.number ?? (r.key === "wavedump" ? "-" : r.key)}</td>
                          {tableTags.map((t) => <td key={t.name} className="mono">{values[r.key]?.[t.name] ?? <span className="muted">-</span>}</td>)}
                          <td className="mono num">{r.events != null ? r.events.toLocaleString() : "-"}</td>
                          <td><span className={"ql-health " + h.cls} title={h.title}>{h.text}</span></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p className="muted ql-note">Dimmed rows are left out of the plot by its filter or series, or cannot be read yet. Hover a row for its note and tags.</p>
            </>
          ) : null}
        </div>

        {folder ? (
          <div className="card ql-card">
            <div className="ql-row-between"><h2>Channels</h2><span className="muted">{inUse} of 16 in use</span></div>
            <div className="ql-chans">
              {prefs.channels.map((c, i) => (
                <button key={i} className={"ql-ch" + (c.struck ? " off" : "") + (c.source !== `in:${i}` && !c.struck ? " sub" : "") + (chOpen === i ? " pick" : "")}
                  aria-label={chLabel(i)} aria-expanded={chOpen === i} onClick={() => setChOpen(chOpen === i ? null : i)}>
                  <span className="mono">{i}</span>
                  <small>{c.struck ? "off" : c.source.startsWith("tr0") ? "TR0" : c.source !== `in:${i}` ? `in ${c.source.slice(3)}` : ""}</small>
                </button>
              ))}
            </div>
            {chOpen !== null ? (
              <div className="ql-pop">
                <label className="ql-row-between"><b>ch {chOpen} reads</b>
                  <select value={prefs.channels[chOpen].source}
                    onChange={(e) => setPrefs((p) => ({ ...p, channels: p.channels.map((c, i) => i === chOpen ? { ...c, source: e.target.value } : c) }))}>
                    <option value={`in:${chOpen}`}>input {chOpen}</option>
                    <option value="tr0:0">TR0 (group 0 copy)</option>
                    <option value="tr0:1">TR0 (group 1 copy)</option>
                    {Array.from({ length: N_CH }, (_, k) => k).filter((k) => k !== chOpen).map((k) => (
                      <option key={k} value={`in:${k}`}>input {k}</option>
                    ))}
                  </select>
                </label>
                {prefs.channels[chOpen].source.startsWith("tr0") ? (
                  <span className="muted">TR0 has its own ×2 attenuator; values are converted to input volts so ch {chOpen} compares with its neighbours. Its noise in input volts is about twice theirs.</span>
                ) : null}
                <label className="ql-check"><input type="checkbox" checked={prefs.channels[chOpen].struck}
                  onChange={(e) => setPrefs((p) => ({ ...p, channels: p.channels.map((c, i) => i === chOpen ? { ...c, struck: e.target.checked } : c) }))} /> Strike ch {chOpen} from the analysis</label>
                <div className="ql-row-between">
                  <button className="mini" onClick={() => setPrefs((p) => ({ ...p, channels: defaultPrefs().channels }))}>Reset all channels</button>
                  <button className="mini" onClick={() => setChOpen(null)}>Done</button>
                </div>
              </div>
            ) : null}
            <span className="muted">Click a channel to change what feeds it or to strike it. This view only; the data is never touched.</span>
          </div>
        ) : null}

        {folder ? (
          <div className="card ql-card">
            <div className="ql-row-between"><h2>Event selection</h2>
              {passFrac !== null ? <span className="mono ql-pass">{(passFrac * 100).toFixed(1)}% pass</span> : null}
            </div>
            <div className="ql-tags">
              <button className={"ql-slot filter" + (prefs.noClip ? "" : " off")} aria-pressed={prefs.noClip}
                title="Drop events where any channel in use touches the ADC rail"
                onClick={() => setPrefs((p) => ({ ...p, noClip: !p.noClip }))}>no clipping {prefs.noClip ? "✓" : ""}</button>
              {prefs.cuts.map((c, i) => (
                <span key={i} className="ql-slot filter">{c.channel === "sum" ? "Σ" : `ch ${c.channel}`} {c.quantity}{" "}
                  {c.min !== null && c.max !== null ? `${c.min}–${c.max}` : c.min !== null ? `≥ ${c.min}` : `≤ ${c.max}`} {UNIT[c.quantity]}
                  <button className="ql-x" aria-label="Remove cut" onClick={() => setPrefs((p) => ({ ...p, cuts: p.cuts.filter((_, k) => k !== i) }))}>×</button>
                </span>
              ))}
              {addCut ? null : <button className="ql-slot add" onClick={() => setAddCut(true)}>+ cut</button>}
            </div>
            {addCut ? <CutForm channels={prefs.channels} onAdd={(c) => { setPrefs((p) => ({ ...p, cuts: [...p.cuts, c] })); setAddCut(false); }}
              onCancel={() => setAddCut(false)} /> : null}
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
          {tooMany ? <div className="ql-warn">{tooMany} more series not shown - filter, or pick a tag with fewer values.</div> : null}
          {dropped && folder ? <div className="muted">{dropped} selected run{dropped === 1 ? " has" : "s have"} no value for {kind === "tag" ? `${xTag}${effSpec.seriesTag ? " or " + effSpec.seriesTag : ""}` : effSpec.seriesTag} and {dropped === 1 ? "is" : "are"} left out.</div> : null}

          {kind === "spatial" ? (
            <Spatial result={result} prefs={prefs} setPrefs={setPrefs} colorOf={colorOf} seriesLabel={seriesLabel} />
          ) : (
            <div className="ql-plot-row">
              <div className="ql-plot">
                {chart ? <Chart ref={chartRef} {...chart}
                  empty={!selected.length ? "Select some runs." : !groups.length ? "No runs match." : "Reading…"} />
                  : <div className="ql-chart-empty muted">{!folder ? "Open a folder to begin." : !selected.length ? "Select some runs." : !groups.length ? "No runs match this plot." : "Reading…"}</div>}
              </div>
              <div className="ql-legend-col">
                {chart && chart.series.length ? (
                  <div className="ql-legend" aria-label="Legend">
                    {effSpec.seriesTag ? <span className="muted">{effSpec.seriesTag}</span> : null}
                    {seriesNames.map((s) => {
                      const n = new Set(groups.filter((g) => g.series === s).flatMap((g) => g.runs)).size;
                      const hs = plot?.series.find((x) => x.name === s);
                      return (
                        <span key={s}><span className="ql-sw" style={{ background: colorOf(s) }} />{effSpec.seriesTag ? s : "all"}
                          {n > 1 ? <span className="muted"> · {n} runs</span> : null}
                          {kind === "hist" && hs?.stats ? <span className="muted mono ql-legend-stat">μ {fmt(hs.stats.mean)} · σ {fmt(hs.stats.core_sigma)}</span> : null}
                          {kind === "tag" && hs?.fit ? <span className="muted mono ql-legend-stat">a {fmt(hs.fit.a * 100, 2)}% · b {fmt(hs.fit.b * 100, 2)}% · c {fmt(hs.fit.c * 100, 2)}%</span> : null}
                        </span>
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
                  <button className="mini" disabled={!chart} onClick={() => chartRef.current && exportPng(chartRef.current, `${base}.png`)}>Download PNG</button>
                  <button className="mini" disabled={!folder} title="Channels, tags, processing and cuts, as a file you can load again or hand to someone" onClick={exportSettings}>Export settings</button>
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
          <span className={"muted ql-status" + (busy && !pg?.done ? " busy" : "")}>{status}</span>
        </div>

        {folder ? (
          <div className="card ql-card">
            <div className="ql-row-between"><h2>Processing</h2>
              <span className="muted">Drag the shaded windows. Average of the selected runs on{" "}
                <select aria-label="Pulse channel" value={spec.pulseChannel} onChange={(e) => setPlot({ pulseChannel: Number(e.target.value) })}>
                  {Array.from({ length: N_CH }, (_, i) => <option key={i} value={i} disabled={prefs.channels[i].struck}>{chLabel(i)}</option>)}
                </select></span>
            </div>
            <div className="ql-proc">
              <div className="ql-proc-pulse">
                <Pulse pulse={result?.pulse ?? null} processing={prefs.processing}
                  onChange={(p) => setPrefs((q) => ({ ...q, processing: p }))} />
              </div>
              <ProcessingFields prefs={prefs} setPrefs={setPrefs} />
            </div>
          </div>
        ) : null}
      </main>

      {tagDialog && folder ? (
        <TagBuilder runs={runs} initial={tagDialog.def} overrides={prefs.overrides}
          taken={tags.map((t) => t.name)}
          onClose={() => setTagDialog(null)}
          onDelete={(name) => {
            setPrefs((p) => ({ ...p, tags: p.tags.filter((t) => t.name !== name),
              overrides: Object.fromEntries(Object.entries(p.overrides).map(([k, v]) => {
                const { [name]: _, ...rest } = v; return [k, rest];
              })) }));
            setTagDialog(null);
          }}
          onSave={(def, fixes, oldName) => {
            setPrefs((p) => {
              const tagsNext = oldName ? p.tags.map((t) => t.name === oldName ? def : t) : [...p.tags, def];
              const ov: FolderPrefs["overrides"] = {};
              for (const [k, v] of Object.entries(p.overrides)) {
                const { [oldName ?? def.name]: _, ...rest } = v;
                ov[k] = rest;
              }
              for (const [k, v] of Object.entries(fixes)) ov[k] = { ...(ov[k] ?? {}), [def.name]: v };
              const plotNext = oldName && oldName !== def.name ? {
                ...p.plot,
                seriesTag: p.plot.seriesTag === oldName ? def.name : p.plot.seriesTag,
                xTag: p.plot.xTag === oldName ? def.name : p.plot.xTag,
                filters: p.plot.filters.map((f) => f.tag === oldName ? { ...f, tag: def.name } : f),
              } : p.plot;
              return { ...p, tags: tagsNext, overrides: ov, plot: plotNext };
            });
            setTagDialog(null);
          }} />
      ) : null}
    </div>
  );
}

function RecipeIcon({ id }: { id: Recipe }) {
  const d: Record<Recipe, JSX.Element> = {
    waveform: <path d="M1 10h3l2-6 3 10 2-4h6" />,
    hist: <path d="M2 16V12M6 16V6M10 16V3M14 16V9" />,
    channel: <><path d="M2 13l4-5 3 3 3-7 4 6" /><circle cx="6" cy="8" r="1.3" /><circle cx="12" cy="4" r="1.3" /></>,
    tag: <><path d="M2 16L16 2" /><circle cx="5" cy="13" r="1.3" /><circle cx="9" cy="9" r="1.3" /><circle cx="13" cy="5" r="1.3" /></>,
    resolution: <path d="M2 3c2 9 6 12 14 12" />,
    spatial: <><rect x="2" y="2" width="14" height="14" rx="1.5" /><path d="M2 9h14M9 2v14" /></>,
  };
  return <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">{d[id]}</svg>;
}

function FilterForm({ tagNames, valuesOf, onAdd, onCancel }: {
  tagNames: string[]; valuesOf: (tag: string) => string[];
  onAdd: (f: Filter) => void; onCancel: () => void;
}) {
  const [tag, setTag] = useState(tagNames.find((t) => t !== "run") ?? "run");
  const vals = valuesOf(tag);
  const [val, setVal] = useState(vals[0] ?? "");
  const v = vals.includes(val) ? val : (vals[0] ?? "");
  return (
    <span className="ql-inline-form">
      <select aria-label="Filter tag" value={tag} onChange={(e) => setTag(e.target.value)}>
        {tagNames.map((t) => <option key={t}>{t}</option>)}
      </select>
      <span>=</span>
      <select aria-label="Filter value" value={v} onChange={(e) => setVal(e.target.value)}>
        {vals.map((x) => <option key={x}>{x}</option>)}
      </select>
      <button className="mini primary" disabled={!vals.length} onClick={() => onAdd({ tag, value: v })}>Add</button>
      <button className="mini" onClick={onCancel}>Cancel</button>
    </span>
  );
}

function CutForm({ channels, onAdd, onCancel }: {
  channels: FolderPrefs["channels"]; onAdd: (c: Cut) => void; onCancel: () => void;
}) {
  const [quantity, setQuantity] = useState<Quantity>("charge");
  const [channel, setChannel] = useState<ChanSel>("sum");
  const [min, setMin] = useState("");
  const [max, setMax] = useState("");
  const n = (s: string) => (s.trim() === "" || !isFinite(Number(s)) ? null : Number(s));
  const ok = n(min) !== null || n(max) !== null;
  return (
    <div className="ql-cutform">
      <select aria-label="Cut channel" value={String(channel)} onChange={(e) => setChannel(e.target.value === "sum" ? "sum" : Number(e.target.value))}>
        {quantity === "charge" ? <option value="sum">Σ all channels</option> : null}
        {channels.map((c, i) => <option key={i} value={i} disabled={c.struck}>ch {i}</option>)}
      </select>
      <select aria-label="Cut quantity" value={quantity} onChange={(e) => {
        const q = e.target.value as Quantity; setQuantity(q); if (q !== "charge" && channel === "sum") setChannel(0);
      }}>
        {QUANTITIES.map((q) => <option key={q}>{q}</option>)}
      </select>
      <input aria-label="Minimum" placeholder="min" value={min} onChange={(e) => setMin(e.target.value)} />
      <input aria-label="Maximum" placeholder="max" value={max} onChange={(e) => setMax(e.target.value)} />
      <span className="muted">{UNIT[quantity]}</span>
      <button className="mini primary" disabled={!ok} onClick={() => onAdd({ quantity, channel, min: n(min), max: n(max) })}>Add</button>
      <button className="mini" onClick={onCancel}>Cancel</button>
    </div>
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

function ProcessingFields({ prefs, setPrefs }: {
  prefs: FolderPrefs; setPrefs: (fn: (p: FolderPrefs) => FolderPrefs) => void;
}) {
  const p = prefs.processing;
  const setProc = (q: Partial<Processing>) => setPrefs((x) => ({ ...x, processing: { ...x.processing, ...q } }));
  const setWin = (w: Partial<Processing["window"]>) => setProc({ window: { ...p.window, ...w } });
  return (
    <div className="ql-proc-fields">
      <div className="ql-step"><span>Baseline</span>
        <span>mean of <NumField label="Baseline from (ns)" value={p.baseline[0]} onCommit={(v) => setProc({ baseline: [v, p.baseline[1]] })} />
          – <NumField label="Baseline to (ns)" value={p.baseline[1]} onCommit={(v) => setProc({ baseline: [p.baseline[0], v] })} /> ns, per event</span></div>
      <div className="ql-step"><label htmlFor="ql-pol">Polarity</label>
        <select id="ql-pol" value={prefs.polarity} onChange={(e) => setPrefs((x) => ({ ...x, polarity: e.target.value as FolderPrefs["polarity"] }))}>
          <option value="auto">auto (per channel)</option><option value="negative">negative</option><option value="positive">positive</option>
        </select></div>
      <div className="ql-step"><label htmlFor="ql-win">Integrate</label>
        <span>
          <select id="ql-win" value={p.window.mode} onChange={(e) => {
            const mode = e.target.value as "record" | "reference";
            setWin(mode === "reference" ? { mode, reference: p.window.reference ?? "tr0:0", range: [-5, 45] } : { mode, range: [60, 120] });
          }}>
            <option value="record">fixed in the record</option><option value="reference">from a reference pulse</option>
          </select>
          {p.window.mode === "reference" ? (
            <select aria-label="Integration reference" value={p.window.reference ?? "tr0:0"} onChange={(e) => setWin({ reference: e.target.value })}><SourceOptions /></select>
          ) : null}
          {" "}<NumField label="Integrate from (ns)" value={p.window.range[0]} onCommit={(v) => setWin({ range: [v, p.window.range[1]] })} />
          – <NumField label="Integrate to (ns)" value={p.window.range[1]} onCommit={(v) => setWin({ range: [p.window.range[0], v] })} /> ns
        </span></div>
      <div className="ql-step"><span>Timing</span>
        <span>CFD <NumField label="CFD fraction (%)" step={5} value={Math.round(p.cfd * 100)} onCommit={(v) => setProc({ cfd: Math.min(95, Math.max(5, v)) / 100 })} />%
          {" "}vs{" "}
          <select aria-label="Timing reference" value={prefs.timingRef ?? ""} onChange={(e) => setPrefs((x) => ({ ...x, timingRef: e.target.value || null }))}>
            <option value="">no reference (record time)</option><SourceOptions />
          </select></span></div>
      <p className="muted">One set for the whole folder. Windows and CFD reread the runs; everything else is instant.</p>
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
                  <div key={i} className="ql-cell" style={shade(c.share)}>
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
            <span className="muted mono">{s.centroid ? `centroid (${fmt(s.centroid.x, 2)}, ${fmt(s.centroid.y, 2)}) mm · spread ${fmt(s.centroid.sx, 2)} × ${fmt(s.centroid.sy, 2)}` : "no events"}</span>
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
