import type { BoardConfig, Catalog, Telemetry } from "../types";
import { MiniWave } from "./MiniWave";

interface Props {
  catalog: Catalog;
  config: BoardConfig;
  tele: Telemetry | null;
  selected: number;
  onSelect: (ch: number) => void;
}

const DEAD_VPP = 30;      // below this = likely dead / no signal
const RAIL_LO = 5, RAIL_HI = 4090;  // 12-bit corrected range clip guards

export function ChannelGrid({ catalog, config, tele, selected, onSelect }: Props) {
  const n = catalog.geometry.num_channels;
  const gsize = catalog.geometry.group_size;

  // shared amplitude scale across enabled channels (so gain differences show)
  let scale = 50;
  if (tele) {
    for (const ch of tele.enabled_channels) {
      const e = tele.channels[String(ch)];
      if (e?.baseline != null && e.max != null && e.min != null) {
        scale = Math.max(scale, e.max - e.baseline, e.baseline - e.min);
      }
    }
  }

  return (
    <div className="grid16">
      {Array.from({ length: n }, (_, ch) => {
        const group = Math.floor(ch / gsize);
        const on = config.groups[group]?.enabled;
        const e = tele?.channels[String(ch)];
        const has = !!e?.wave;
        const vpp = e?.vpp ?? 0;
        const clip = has && (e!.max! >= RAIL_HI || e!.min! <= RAIL_LO);
        const dead = on && has && vpp < DEAD_VPP;
        const color = !on ? "#3a4150" : dead ? "#8b5cf6" : clip ? "#f0883e" : "#4ac776";
        let badge = "", bcls = "";
        if (!on) { badge = "off"; bcls = "off"; }
        else if (clip) { badge = "CLIP"; bcls = "clip"; }
        else if (dead) { badge = "DEAD"; bcls = "dead"; }

        return (
          <button
            key={ch}
            className={"tile" + (selected === ch ? " sel" : "") + (on ? "" : " disabled")}
            onClick={() => onSelect(ch)}
          >
            <div className="tile-head">
              <span className="ch">CH {ch}</span>
              <span className="g">bank {group}</span>
              {badge ? <span className={"badge " + bcls}>{badge}</span> : null}
            </div>
            <MiniWave wave={on ? e?.wave : undefined} baseline={e?.baseline} scale={scale} color={color} />
            <div className="tile-foot">
              <span>Vpp {on && has ? vpp.toFixed(0) : "—"}</span>
              <span className="n">{e?.count ? `n=${e.count}` : ""}</span>
            </div>
          </button>
        );
      })}
    </div>
  );
}
