/** Quick Look's view of a folder and of one analysis, as the server sends
 *  them (server/daq/quicklook). Everything here is read-only data. */

export interface QlFolderEntry { id: string; label: string; runs: number; wavedump: boolean; started: number }

export type RunState = "ok" | "recording" | "unfinished" | "unsupported";

export interface QlRun {
  key: string;
  file: string | null;
  /** The run's folder name (run_002_10GeV-electrons), or its file name in a flat folder. */
  name: string;
  number: number | null;
  note: string;
  experiment: Record<string, string>;
  events: number | null;
  started: number | null;
  bytes: number;
  state: RunState;
  reason: string;
}

export interface QlFolder {
  folder: string;
  path: string;
  runs: QlRun[];
  channel_names: Record<string, string>;
  has_metadata: boolean;
}

export type Quantity = "charge" | "amplitude" | "time" | "pedestal" | "noise";
export type Stat = "mean" | "median" | "sigma" | "resolution";
export type Err = "rms" | "sem" | "none";
export type Kind = "channel" | "tag" | "hist" | "spatial" | "waveform";
export type ChanSel = number | "sum";

export interface Cut { quantity: Quantity; channel: ChanSel; min: number | null; max: number | null }

export interface Processing {
  baseline: [number, number];
  window: { mode: "record" | "reference"; range: [number, number]; reference: string | null };
  cfd: number;
}

export interface ChannelSetting { source: string; struck: boolean }

export interface RunResult {
  state: "full" | "preview" | "pending" | "error";
  frac: number;
  error: string | null;
  events: number | null;
  passed?: number;
  clip_frac?: number;
  ped_shift?: { channel: number; mv: number };
}

export interface XYPoint {
  x: number | null; y: number | null; err?: number | null; n?: number;
  off?: boolean; per_run?: Record<string, number | null>; runs?: string[];
}

export interface Stats {
  n: number; mean: number | null; median: number | null; rms: number | null;
  core_mean: number | null; core_sigma: number | null;
}

export interface PlotSeries {
  name: string;
  runs?: string[];
  points?: XYPoint[];
  fit?: { a: number; b: number; c: number; curve: [number, number][] } | null;
  counts?: number[];
  stats?: Stats;
  cells?: { channel: number; share: number | null }[];
  centroid?: { x: number; y: number; sx: number; sy: number; n: number } | null;
  t?: number[];
  v?: number[];
  events?: number;
}

export interface PlotResult {
  kind: Kind; quantity: Quantity; unit: string; stat: Stat; err: Err;
  series: PlotSeries[];
  channel?: ChanSel;
  edges?: number[];
  rows?: number; cols?: number; pitch?: number;
}

export interface Analysis {
  ok: boolean;
  folder: string;
  progress: { total: number; full: number; preview: number; errors: number; frac: number; done: boolean };
  runs: Record<string, RunResult>;
  polarity: ("neg" | "pos")[];
  events: number;
  passed: number;
  plot: PlotResult;
  pulse: { t: number[]; v: number[]; events: number; channel: number; ref_t0?: number | null } | null;
}
