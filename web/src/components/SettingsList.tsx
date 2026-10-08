import type { Catalog, SettingDef } from "../types";
import { SettingControl } from "./SettingControl";
import { LockToggle } from "./LockToggle";

interface Props {
  defs: SettingDef[];
  geom: Catalog["geometry"];
  get: (key: string) => any;
  onChange: (key: string, value: any) => void;
  skip?: string[];
  /** Per-setting locks (house style: the icon left of the label) for the
   *  OPTIONAL settings - the ones that once carried an "uncheck to return
   *  to default" checkbox, which was a lock done badly. A locked row still
   *  shows its value - protection, not concealment. */
  locked?: (key: string) => boolean;
  onToggleLock?: (key: string) => void;
}

/** Required settings first - the ones every run must have deliberately chosen -
 *  then the optional ones under their own divider, each with its lock. While
 *  any row has a lock, the others keep a spacer so the labels line up. */
export function SettingsList({ defs, geom, get, onChange, skip = [],
                               locked, onToggleLock }: Props) {
  const canLock = !!locked && !!onToggleLock;
  const isLocked = (key: string) => locked?.(key) ?? false;
  const shown = defs.filter((d) => !skip.includes(d.key));
  // Only an entry that declares its default counts as optional. Tiers whose
  // catalog carries no defaults (the bank panel) render every row plainly.
  const isOptional = (d: SettingDef) => !d.required && d.default !== undefined;
  const required = shown.filter((d) => !isOptional(d));
  const optional = shown.filter(isOptional);

  const anyLock = canLock && optional.length > 0;
  const row = (def: SettingDef) => {
    const lockable = canLock && isOptional(def);
    const lk = lockable && isLocked(def.key);
    return (
      <div className={"setting-row" + (anyLock ? " lockable" + (lk ? " locked" : "") : "")}
        key={def.key}
        title={[def.help, def.caen].filter(Boolean).join("\n\n")}>
        {lockable ? (
          <LockToggle locked={lk} what={def.label}
            onToggle={() => onToggleLock!(def.key)} />
        ) : anyLock ? <span className="lock-spacer" /> : null}
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
