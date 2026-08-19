import { useMemo } from "react";
import uPlot from "uplot";
import type { BoardConfig, Catalog, Telemetry } from "../types";
import { UPlotChart } from "./UPlotChart";

interface Props {
  catalog: Catalog;
  config: BoardConfig;
  selected: number;
  tele: Telemetry | null;
  onDcOffset: (ch: number, v: number) => void;
  onFanout: (scope: "bank" | "all") => void;
}

export function ChannelEditor({ catalog, config, selected, tele, onDcOffset, onFanout }: Props) {
  const gsize = catalog.geometry.group_size;
  const group = Math.floor(selected / gsize);
  const on = config.groups[group]?.enabled;
  const e = tele?.channels[String(selected)];
  const dt = tele?.sample_period_ns ?? 0.2;

  const data = useMemo<uPlot.AlignedData>(() => {
    if (!e?.wave) return [[], []];
    return [e.wave.map((_, i) => i * dt * (tele!.record_length / e.wave!.length)), e.wave];
  }, [e, dt, tele]);

  const opts = useMemo<Omit<uPlot.Options, "width" | "height">>(() => ({
    scales: { x: { time: false } },
    axes: [{ label: "ns", stroke: "#8b949e" }, { label: "ADC", stroke: "#8b949e" }],
    series: [{}, { label: `CH ${selected}`, stroke: "#4ac776", width: 1.5, points: { show: false } }],
    cursor: { drag: { x: true, y: false } },
  }), [selected]);

  const dc = config.channels[selected]?.dc_offset ?? 0;
  const def = catalog.channel.find((d) => d.key === "dc_offset")!;

  return (
    <div>
      <div className="editor-head">
        <strong>CH {selected}</strong>
        <span className="g">bank {group}</span>
        {!on ? <span className="badge off">bank off</span> : null}
      </div>
      <UPlotChart options={opts} data={data} height={150} />
      <div className="editor-stats">
        <span>Vpp <b>{e?.vpp != null ? e.vpp.toFixed(0) : "—"}</b></span>
        <span>base <b>{e?.baseline != null ? e.baseline.toFixed(0) : "—"}</b></span>
        <span>min <b>{e?.min != null ? e.min.toFixed(0) : "—"}</b></span>
        <span>max <b>{e?.max != null ? e.max.toFixed(0) : "—"}</b></span>
      </div>
      <div className="editor-dc">
        <label>DC offset</label>
        <input type="number" min={def.min} max={def.max} value={dc}
          onChange={(ev) => onDcOffset(selected, ev.target.value === "" ? 0 : Number(ev.target.value))} />
        <div className="fan-btns">
          <button onClick={() => onFanout("bank")}>→ bank</button>
          <button onClick={() => onFanout("all")}>→ all</button>
        </div>
      </div>
      <p className="muted">{def.help}</p>
    </div>
  );
}
