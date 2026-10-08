import { useState } from "react";
import type { Catalog, SettingDef } from "../types";
import { SettingControl } from "./SettingControl";
import { LockToggle } from "./LockToggle";

interface Props {
  defs: SettingDef[];
  geom: Catalog["geometry"];
  get: (key: string) => any;
  onChange: (key: string, value: any) => void;
  skip?: string[];
  /** Per-setting locks (house style: the icon left of the label). A locked
   *  row still shows its value - protection, not concealment. Absent = the
   *  rows are not lockable. `lockPrefix` namespaces the keys, so bank 0's
   *  and bank 1's "enabled" lock separately. */
  locked?: (key: string) => boolean;
  onToggleLock?: (key: string) => void;
  lockPrefix?: string;
}

/** Required settings first - the ones every run must have deliberately chosen -
 *  then the optional ones, each behind a checkbox. An unchecked optional
 *  setting is pinned to its default: unchecking one writes the default back to
 *  the unit, so the checkbox states always describe what the hardware holds,
 *  not merely what the form shows. */
export function SettingsList({ defs, geom, get, onChange, skip = [],
                               locked, onToggleLock, lockPrefix = "" }: Props) {
  const lockable = !!locked && !!onToggleLock;
  const isLocked = (key: string) => locked?.(lockPrefix + key) ?? false;
  const lockIcon = (def: SettingDef) =>
    lockable ? (
      <LockToggle locked={isLocked(def.key)} what={def.label}
        onToggle={() => onToggleLock!(lockPrefix + def.key)} />
    ) : null;
  const lockCls = (key: string) =>
    lockable ? " lockable" + (isLocked(key) ? " locked" : "") : "";
  const shown = defs.filter((d) => !skip.includes(d.key));
  // Only an entry that declares its default can be pinned to it. Tiers whose
  // catalog carries no defaults (the bank panel) render every row plainly.
  const gated = (d: SettingDef) => !d.required && d.default !== undefined;
  const required = shown.filter((d) => !gated(d));
  const optional = shown.filter(gated);

  // Checked-but-still-at-default rows: engaged by hand, awaiting a first edit.
  // Everything else derives from value !== default, which survives reloads and
  // other operators' changes without any state of its own.
  const [engaged, setEngaged] = useState<Set<string>>(new Set());

  const row = (def: SettingDef) => (
    <div className={"setting-row" + lockCls(def.key)} key={def.key}
      title={[def.help, def.caen].filter(Boolean).join("\n\n")}>
      {lockIcon(def)}
      {/* The unit lives inside the field, not appended to the label. */}
      <label>{def.label}</label>
      <SettingControl def={def} value={get(def.key)} geom={geom}
        dependsOn={def.depends_on ? get(def.depends_on) : undefined}
        disabled={isLocked(def.key)}
        onChange={(v) => onChange(def.key, v)} />
    </div>
  );

  const optionalRow = (def: SettingDef) => {
    const customized = get(def.key) !== def.default;
    const active = customized || engaged.has(def.key);
    const toggle = (on: boolean) => {
      setEngaged((prev) => {
        const next = new Set(prev);
        on ? next.add(def.key) : next.delete(def.key);
        return next;
      });
      if (!on && customized) onChange(def.key, def.default);
    };
    return (
      <div className={"setting-row optional" + (active ? "" : " off") + lockCls(def.key)}
        key={def.key}
        title={[def.help, def.caen].filter(Boolean).join("\n\n")}>
        {lockIcon(def)}
        <input type="checkbox" checked={active} disabled={isLocked(def.key)}
          title={active ? "Uncheck to return this setting to its default"
                        : "Check to customize this setting"}
          onChange={(e) => toggle(e.target.checked)} />
        <label>{def.label}</label>
        <SettingControl def={def} value={get(def.key)} geom={geom}
          dependsOn={def.depends_on ? get(def.depends_on) : undefined}
          disabled={!active || isLocked(def.key)}
          onChange={(v) => onChange(def.key, v)} />
      </div>
    );
  };

  return (
    <div className="settings-grid">
      {required.map(row)}
      {optional.length ? (
        <>
          <div className="settings-divider"
            title="Unchecked settings stay at their defaults">Optional</div>
          {optional.map(optionalRow)}
        </>
      ) : null}
    </div>
  );
}
