import type { Catalog, SettingDef } from "../types";
import { SettingControl } from "./SettingControl";

interface Props {
  defs: SettingDef[];
  geom: Catalog["geometry"];
  get: (key: string) => any;
  onChange: (key: string, value: any) => void;
  skip?: string[];
}

export function SettingsList({ defs, geom, get, onChange, skip = [] }: Props) {
  return (
    <div className="settings-grid">
      {defs.filter((d) => !skip.includes(d.key)).map((def) => (
        // Tooltip on the row, so hovering the control explains it too - not
        // only the label.
        <div className="setting-row" key={def.key}
          title={[def.help, def.caen].filter(Boolean).join("\n\n")}>
          {/* The unit lives inside the field, not appended to the label. */}
          <label>{def.label}</label>
          <SettingControl def={def} value={get(def.key)} geom={geom}
            dependsOn={def.depends_on ? get(def.depends_on) : undefined}
            onChange={(v) => onChange(def.key, v)} />
        </div>
      ))}
    </div>
  );
}
