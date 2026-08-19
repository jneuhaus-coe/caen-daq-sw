import type { BoardConfig, Catalog } from "../types";
import { SettingsList } from "./SettingsList";

interface Props {
  catalog: Catalog;
  config: BoardConfig;
  onGroupChange: (group: number, key: string, value: any) => void;
}

export function BankPanel({ catalog, config, onGroupChange }: Props) {
  const gsize = catalog.geometry.group_size;
  return (
    <div className="banks">
      {config.groups.map((g, gi) => (
        <div key={gi} className={"bank" + (g.enabled ? " on" : "")}>
          <div className="bank-head">
            <label className="switch">
              <input type="checkbox" checked={g.enabled}
                onChange={(e) => onGroupChange(gi, "enabled", e.target.checked)} />
              <strong>Bank {gi}</strong>
            </label>
            <span className="bank-ch">CH {gi * gsize}–{gi * gsize + gsize - 1}</span>
          </div>
          {g.enabled ? (
            <SettingsList
              defs={catalog.bank}
              skip={["enabled"]}
              get={(k) => (g as any)[k]}
              onChange={(k, v) => onGroupChange(gi, k, v)}
            />
          ) : null}
        </div>
      ))}
    </div>
  );
}
