import type { SettingDef } from "../types";

interface Props {
  def: SettingDef;
  value: any;
  onChange: (v: any) => void;
  compact?: boolean;
}

/** Renders one setting (enum/int/bool) from a catalog definition. */
export function SettingControl({ def, value, onChange, compact }: Props) {
  if (def.type === "bool") {
    return (
      <input
        type="checkbox"
        checked={!!value}
        onChange={(e) => onChange(e.target.checked)}
      />
    );
  }
  if (def.type === "enum") {
    return (
      <select value={String(value)} onChange={(e) => {
        const raw = e.target.value;
        const num = def.choices?.find((c) => String(c.value) === raw)?.value;
        onChange(typeof num === "number" ? num : raw);
      }}>
        {def.choices?.map((c) => (
          <option key={String(c.value)} value={String(c.value)}>{c.label}</option>
        ))}
      </select>
    );
  }
  // int
  return (
    <input
      type="number"
      value={value ?? 0}
      min={def.min}
      max={def.max}
      style={compact ? { width: 78 } : undefined}
      onChange={(e) => onChange(e.target.value === "" ? 0 : Number(e.target.value))}
    />
  );
}
