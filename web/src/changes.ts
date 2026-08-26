import type { BoardConfig, Catalog, SettingDef } from "./types";
import { defDacToVolts, fmtV } from "./volts";

/** Describe what the unit actually holds now, in the operator's units.
 *
 *  The point is to distinguish "we sent it" from "the unit took it": every line
 *  is built from the config the board reported back, and when that differs from
 *  what was asked for (post-trigger snapping, clamping) the request is shown
 *  alongside it. */
export function describeChanges(
  before: BoardConfig, after: BoardConfig, requested: BoardConfig, cat: Catalog,
): string[] {
  const geom = cat.geometry;
  const out: string[] = [];

  const fmt = (def: SettingDef | undefined, v: any) => {
    if (!def) return String(v);
    if (def.type === "volts") return fmtV(defDacToVolts(def, Number(v), geom));
    if (def.type === "bool") return v ? "on" : "off";
    if (def.type === "enum") {
      const c = def.choices?.find((c) => String(c.value) === String(v));
      return c ? c.label : String(v);
    }
    if (def.type === "steps") {
      // Report it the way the control shows it, with the unit's own percentage
      // alongside so the two never look like different settings.
      const list = def.values_by_freq?.[String(after.drs4_frequency)] ?? [];
      const hit = list.find((s) => s.pct === Number(v));
      return hit ? `${hit.ns} ns (${hit.pct}%)` : `${v}%`;
    }
    return String(v) + (def.unit ? def.unit : "");
  };

  const note = (label: string, def: SettingDef | undefined, got: any, want: any) => {
    const shown = fmt(def, got);
    out.push(String(want) !== String(got)
      ? `${label}: ${shown}  (asked ${fmt(def, want)})`
      : `${label}: ${shown}`);
  };

  for (const def of cat.unit) {
    const a = (before as any)[def.key], b = (after as any)[def.key];
    if (a !== b) note(def.label, def, b, (requested as any)[def.key]);
  }

  after.groups.forEach((g, gi) => {
    for (const def of cat.bank) {
      const a = (before.groups[gi] as any)?.[def.key], b = (g as any)[def.key];
      if (a !== b) note(`Bank ${gi} ${def.label.toLowerCase()}`, def, b,
                        (requested.groups[gi] as any)?.[def.key]);
    }
  });

  const dcDef = cat.channel.find((d) => d.key === "dc_offset");
  after.channels.forEach((c, ch) => {
    const b0 = before.channels[ch];
    if (b0 && b0.dc_offset !== c.dc_offset) {
      note(`CH ${ch} DC offset`, dcDef, c.dc_offset, requested.channels[ch]?.dc_offset);
    }
    if (b0 && b0.name !== c.name) {
      out.push(`CH ${ch} name: ${c.name || "(cleared)"}`);
    }
  });

  return out;
}
