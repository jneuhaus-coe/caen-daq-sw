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
        <div className="setting-row" key={def.key}>
          {/* The tooltip explains the setting; the CAEN call is a footnote. */}
          <label title={[def.help, def.caen].filter(Boolean).join("\n\n")}>
            {def.label}{def.unit ? <span className="unit"> ({def.unit})</span> : null}
          </label>
          <SettingControl def={def} value={get(def.key)} geom={geom}
            onChange={(v) => onChange(def.key, v)} />
        </div>
      ))}
    </div>
  );
}
