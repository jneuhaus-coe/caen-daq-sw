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
 *  then the optional ones under their own divider. Every row is an ordinary
 *  lockable setting; the optional ones are simply the ones that are usually
 *  left at their defaults. */
export function SettingsList({ defs, geom, get, onChange, skip = [],
                               locked, onToggleLock, lockPrefix = "" }: Props) {
  const lockable = !!locked && !!onToggleLock;
  const isLocked = (key: string) => locked?.(lockPrefix + key) ?? false;
  const shown = defs.filter((d) => !skip.includes(d.key));
  // Only an entry that declares its default counts as optional. Tiers whose
  // catalog carries no defaults (the bank panel) render every row plainly.
  const isOptional = (d: SettingDef) => !d.required && d.default !== undefined;
  const required = shown.filter((d) => !isOptional(d));
  const optional = shown.filter(isOptional);

  const row = (def: SettingDef) => {
    const lk = isLocked(def.key);
    return (
      <div className={"setting-row" + (lockable ? " lockable" + (lk ? " locked" : "") : "")}
        key={def.key}
        title={[def.help, def.caen].filter(Boolean).join("\n\n")}>
        {lockable ? (
          <LockToggle locked={lk} what={def.label}
            onToggle={() => onToggleLock!(lockPrefix + def.key)} />
        ) : null}
        {/* The unit lives inside the field, not appended to the label. */}
        <label>{def.label}</label>
        <SettingControl def={def} value={get(def.key)} geom={geom}
          dependsOn={def.depends_on ? get(def.depends_on) : undefined}
          disabled={lk}
          onChange={(v) => onChange(def.key, v)} />
      </div>
    );
  };

  return (
    <div className="settings-grid">
      {required.map(row)}
      {optional.length ? (
        <>
          <div className="settings-divider">Optional</div>
          {optional.map(row)}
        </>
      ) : null}
    </div>
  );
}
