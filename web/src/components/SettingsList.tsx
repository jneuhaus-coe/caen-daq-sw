import type { SettingDef } from "../types";
import { SettingControl } from "./SettingControl";

interface Props {
  defs: SettingDef[];
  get: (key: string) => any;
  onChange: (key: string, value: any) => void;
  skip?: string[];
}

export function SettingsList({ defs, get, onChange, skip = [] }: Props) {
  return (
    <div className="settings-grid">
      {defs.filter((d) => !skip.includes(d.key)).map((def) => (
        <div className="setting-row" key={def.key} title={def.caen || ""}>
          <label>
            {def.label}{def.unit ? <span className="unit"> ({def.unit})</span> : null}
          </label>
          <SettingControl def={def} value={get(def.key)} onChange={(v) => onChange(def.key, v)} />
          {def.help ? <div className="help">{def.help}</div> : null}
        </div>
      ))}
    </div>
  );
}
