import { useState } from "react";
import type { BoardConfig, Catalog, Telemetry } from "../types";
import { MiniWave } from "./MiniWave";
import { BlurInput } from "./BlurInput";
import { dacToVolts, voltsToDac } from "../volts";

interface Props {
  catalog: Catalog;
  config: BoardConfig;
  tele: Telemetry | null;
  onDcOffset: (ch: number, dac: number) => void;
  onName: (ch: number, name: string) => void;
}

const DEAD_VPP = 30;      // below this = likely dead / no signal
const RAIL_LO = 5, RAIL_HI = 4090;  // 12-bit corrected range clip guards

export function ChannelGrid({ catalog, config, tele, onDcOffset, onName }: Props) {
  const g = catalog.geometry;
  const gsize = g.group_size;
  // undefined = follow the bank's enabled flag; set = the user overrode it
  const [open, setOpen] = useState<Record<number, boolean>>({});
  const [renaming, setRenaming] = useState<number | null>(null);

  const windowNs = tele ? tele.sample_period_ns * tele.record_length : undefined;
  const dcDef = catalog.channel.find((d) => d.key === "dc_offset");
  const dcHelp = [dcDef?.help, dcDef?.caen].filter(Boolean).join("\n\n");

  return (
    <div className="banks">
      {config.groups.map((grp, gi) => {
        const on = grp.enabled;
        const shown = open[gi] ?? on;   // disabled banks start collapsed
        const first = gi * gsize;

        return (
          <section key={gi} className={"bank" + (on ? "" : " off")}>
            <button className="bank-head" onClick={() => setOpen((o) => ({ ...o, [gi]: !shown }))}
              aria-expanded={shown}>
              <span className={"chevron" + (shown ? " open" : "")}>&#9656;</span>
              <span className="bank-title">Bank {gi}</span>
              {on ? null : <span className="bank-state">disabled</span>}
              <span className="bank-range">CH {first}&ndash;{first + gsize - 1}</span>
            </button>

            {shown ? (
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

                  const cc = config.channels[ch];
                  const name = cc?.name ?? "";
                  const dac = cc?.dc_offset ?? g.dc_offset_mid;

                  return (
                    <div key={ch} className={"tile" + (on ? "" : " disabled")}>
                      <div className="tile-head">
                        {renaming === ch ? (
                          <span className="ch-edit">
                            {/* Prefix is decoration; it never reaches the name. */}
                            <span className="ch-prefix">CH {ch} -&nbsp;</span>
                            <BlurInput
                              value={name} autoFocus placeholder="name"
                              onCommit={(v) => { setRenaming(null); onName(ch, v.trim()); }}
                              onCancel={() => setRenaming(null)}
                            />
                          </span>
                        ) : (
                          <button className="ch" onClick={() => setRenaming(ch)}
                            title="Click to rename">
                            CH {ch}{name ? " - " + name : ""}
                          </button>
                        )}
                        {badge ? <span className={"badge " + bcls}>{badge}</span> : null}
                      </div>

                      <MiniWave wave={on ? e?.wave : undefined} dcOffset={dac} geom={g}
                        windowNs={windowNs} postTriggerPct={config.post_trigger}
                        color={color} />

                      <div className="tile-dc" title={dcHelp}>
                        <label>DC</label>
                        <BlurInput
                          type="number" step={0.005}
                          min={-g.dc_offset_range_v / 2} max={g.dc_offset_range_v / 2}
                          value={dacToVolts(dac, g).toFixed(3)}
                          selectOnFocus
                          onCommit={(v) => onDcOffset(ch, voltsToDac(Number(v || 0), g))}
                        />
                        <span className="unit">V</span>
                      </div>

                      <div className="tile-foot">
                        <span className="n">{e?.count ? "n=" + e.count : ""}</span>
                      </div>
                    </div>
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
