export interface Choice { value: string | number; label: string; }

export interface SettingDef {
  key: string;
  label: string;
  type: "enum" | "int" | "bool" | "volts" | "steps";
  choices?: Choice[];
  min?: number;
  max?: number;
  unit?: string;
  caen?: string;
  help?: string;
  depends_on?: string;
  values_by_freq?: Record<string, { pct: number; ns: number }[]>;
  record_ns_by_freq?: Record<string, number>;
  /** Must be deliberately chosen for every run; listed before the optional
   *  settings, which sit behind a per-setting checkbox. */
  required?: boolean;
  /** What an optional setting is pinned to while its checkbox is off.
   *  Injected server-side from default_config(), so it cannot drift. */
  default?: any;
}

export interface Catalog {
  unit: SettingDef[];
  bank: SettingDef[];
  channel: SettingDef[];
  geometry: {
    num_channels: number; group_size: number; num_groups: number; record_length: number;
    adc_max: number; input_range_vpp: number;
    dc_offset_max: number; dc_offset_mid: number; dc_offset_range_v: number;
  };
}

export interface ChannelConfig { dc_offset: number; name: string; }

export interface GroupConfig {
  enabled: boolean;
  fast_trigger_threshold: number;
  fast_trigger_dc_offset: number;
}

export interface BoardConfig {
  drs4_frequency: number;
  record_length: number;
  post_trigger: number;
  correction_level: string;
  trigger_edge: string;
  external_trigger: string;
  fast_trigger: string;
  fast_trigger_digitizing: boolean;
  max_events_blt: number;
  test_pattern: boolean;
  output_format: string;
  output_header: boolean;
  output_dir: string;
  write_enabled: boolean;
  groups: GroupConfig[];
  channels: ChannelConfig[];
  [key: string]: any;
}

export interface ChannelTelemetry {
  wave?: number[];
  count: number;
  vpp?: number;
  min?: number;
  max?: number;
  baseline?: number;
}

export interface Telemetry {
  running: boolean;
  sample_period_ns: number;
  record_length: number;
  overview_points: number;
  avg_window_s: number;
  events_seen: number;
  recording: boolean;
  run_id: string | null;
  run_started: number | null;
  recorded: number;
  enabled_channels: number[];
  channels: Record<string, ChannelTelemetry>;
  rate: { bin_seconds: number; window_seconds: number; t: number[]; rate: number[]; instant: number; total: number };
}

export interface Status {
  opened: boolean;
  running: boolean;
  recording: boolean;
  run_id: string | null;
  run_started: number | null;
  recorded: number;
  data_dir: string;
  backend: string;
  board: { model: string; family: string; serial: number; roc_firmware: string; amc_firmware: string; sw_release: string };
  events_seen: number;
  errors: string[];
}

/** How often the header re-checks the board. */
export const STATUS_POLL_MS = 1500;
