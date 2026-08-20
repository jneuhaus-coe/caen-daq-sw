import type { Catalog, SettingDef } from "../types";
import { BlurInput } from "./BlurInput";
import { dacToVolts, voltsToDac } from "../volts";
import { StepControl } from "./StepControl";

interface Props {
  def: SettingDef;
  value: any;
  geom: Catalog["geometry"];
  /** Value of the setting this one's reachable range depends on. */
  dependsOn?: any;
  onChange: (v: any) => void;
}

/** Renders one setting from its catalog definition. Anything that is physically
 *  a voltage is edited as volts; the DAC word never reaches the operator. */
export function SettingControl({ def, value, geom, dependsOn, onChange }: Props) {
  if (def.type === "steps") {
    const steps = def.values_by_freq?.[String(dependsOn)] ?? [];
    return steps.length
      ? <StepControl steps={steps} value={Number(value ?? 0)} onChange={onChange} />
      : <span className="muted">—</span>;
  }

  if (def.type === "bool") {
    return <input type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} />;
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

  if (def.type === "volts") {
    const limit = geom.dc_offset_range_v / 2;
    return (
      <span className="v-input">
        <BlurInput
          type="number" step={0.005} min={-limit} max={limit} selectOnFocus
          value={dacToVolts(Number(value ?? geom.dc_offset_mid), geom).toFixed(3)}
          onCommit={(v) => onChange(voltsToDac(Number(v || 0), geom))}
        />
        <span className="unit">V</span>
      </span>
    );
  }

  return (
    <BlurInput
      type="number" min={def.min} max={def.max} selectOnFocus
      value={value ?? 0}
      onCommit={(v) => onChange(v === "" ? 0 : Number(v))}
    />
  );
}
