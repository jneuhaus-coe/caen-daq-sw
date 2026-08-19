import { useState } from "react";
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
  const gsize = catalog.geometry.group_size;
  // undefined = follow the bank's enabled flag; set = the user overrode it
  const [override, setOverride] = useState<Record<number, boolean>>({});

  const { adc_max, input_range_vpp, dc_offset_half_span } = catalog.geometry;
  const windowNs = tele ? tele.sample_period_ns * tele.record_length : undefined;

  return (
    <div className="banks">
      {config.groups.map((g, gi) => {
        const on = g.enabled;
        const open = override[gi] ?? on;   // disabled banks start collapsed
        const first = gi * gsize;

        return (
          <section key={gi} className={"bank" + (on ? "" : " off")}>
            <button
              className="bank-head"
              onClick={() => setOverride((o) => ({ ...o, [gi]: !open }))}
              aria-expanded={open}
            >
              <span className={"chevron" + (open ? " open" : "")}>▸</span>
              <span className="bank-title">Bank {gi}</span>
              {on ? null : <span className="bank-state">disabled</span>}
              <span className="bank-range">CH {first}–{first + gsize - 1}</span>
            </button>

            {open ? (
              <div className="grid16">
                {Array.from({ length: gsize }, (_, i) => {
                  const ch = first + i;
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
                        {badge ? <span className={"badge " + bcls}>{badge}</span> : null}
                      </div>
                      <MiniWave
                        wave={on ? e?.wave : undefined}
                        dcOffset={config.channels[ch]?.dc_offset ?? 0}
                        adcMax={adc_max} rangeVpp={input_range_vpp}
                        dcHalfSpan={dc_offset_half_span}
                        windowNs={windowNs} color={color} />
                      <div className="tile-foot">
                        <span className="n">{e?.count ? `n=${e.count}` : ""}</span>
                      </div>
                    </button>
                  );
                })}
              </div>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}
