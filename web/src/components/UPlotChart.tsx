import { useEffect, useRef } from "react";
import uPlot from "uplot";

interface Props {
  options: Omit<uPlot.Options, "width" | "height">;
  data: uPlot.AlignedData;
  height: number;
}

/** Thin uPlot wrapper: creates once, feeds data on change, resizes to container. */
export function UPlotChart({ options, data, height }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const plotRef = useRef<uPlot | null>(null);
  const dataRef = useRef(data);
  dataRef.current = data;

  useEffect(() => {
    if (!hostRef.current) return;
    const width = hostRef.current.clientWidth || 800;
    const plot = new uPlot({ ...options, width, height }, dataRef.current, hostRef.current);
    plotRef.current = plot;
    const ro = new ResizeObserver(() => {
      if (hostRef.current) plot.setSize({ width: hostRef.current.clientWidth, height });
    });
    ro.observe(hostRef.current);
    return () => { ro.disconnect(); plot.destroy(); plotRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [height]);

  useEffect(() => {
    plotRef.current?.setData(data);
  }, [data]);

  return <div ref={hostRef} style={{ width: "100%" }} />;
}
