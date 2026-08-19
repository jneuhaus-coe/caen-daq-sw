import { useMemo } from "react";
import uPlot from "uplot";
import type { Telemetry } from "../types";
import { UPlotChart } from "./UPlotChart";

export function RateStrip({ tele }: { tele: Telemetry | null }) {
  const data = useMemo<uPlot.AlignedData>(() => {
    if (!tele) return [[], []];
    return [tele.rate.t, tele.rate.rate];
  }, [tele]);

  const opts = useMemo<Omit<uPlot.Options, "width" | "height">>(() => ({
    scales: { x: { time: false } },
    axes: [
      { label: "s ago", stroke: "#8b949e", size: 34 },
      { stroke: "#8b949e", size: 40 },
    ],
    series: [{}, { label: "trg/s", stroke: "#1f6feb", fill: "rgba(31,111,235,0.15)", width: 1.5, points: { show: false } }],
    legend: { show: false },
  }), []);

  return (
    <div>
      <div className="rate-num">
        <span className="big mono">{(tele?.rate.instant ?? 0).toFixed(1)}</span>
        <span className="unit">trg/s</span>
        <span className="total muted">total {tele?.rate.total ?? 0}</span>
      </div>
      <UPlotChart options={opts} data={data} height={90} />
    </div>
  );
}
