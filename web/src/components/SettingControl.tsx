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
  /** An optional setting whose checkbox is off renders inert. */
  disabled?: boolean;
  onChange: (v: any) => void;
}

/** Whatever was typed lands inside [min, max]. The HTML attributes alone only
 *  style the spinner - they do not stop a typed 5000 from reaching a field
 *  whose hardware ceiling is 1023, so the commit path is where the bound is
 *  enforced. NaN (a cleared field) falls back to the nearer of min or 0. */
function clamp(raw: number, min?: number, max?: number): number {
  let v = Number.isFinite(raw) ? raw : (min ?? 0);
  if (min !== undefined) v = Math.max(min, v);
  if (max !== undefined) v = Math.min(max, v);
  return v;
}

/** Renders one setting from its catalog definition. Anything that is physically
 *  a voltage is edited as volts; the DAC word never reaches the operator. */
export function SettingControl({ def, value, geom, dependsOn, disabled, onChange }: Props) {
  if (def.type === "steps") {
    const steps = def.values_by_freq?.[String(dependsOn)] ?? [];
    return steps.length
      ? <StepControl steps={steps} value={Number(value ?? 0)} onChange={onChange} />
      : <span className="muted">—</span>;
  }

  if (def.type === "bool") {
    return <input type="checkbox" checked={!!value} disabled={disabled}
      onChange={(e) => onChange(e.target.checked)} />;
  }

  if (def.type === "enum") {
    return (
      <select value={String(value)} disabled={disabled} onChange={(e) => {
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
    // A setting with its own calibration (the TR path) converts linearly by
    // lsb_v/zero_dac; the channel-input model is the default. Either way the
    // wire value is a 16-bit DAC word and the bounds are its endpoints.
    if (def.lsb_v != null && def.zero_dac != null) {
      const k = def.lsb_v, z = def.zero_dac;
      const ends = [(0 - z) * k, (0xFFFF - z) * k];
      const lo = Math.min(...ends), hi = Math.max(...ends);
      return (
        <span className="field">
          <BlurInput
            type="number" step={0.001} min={lo} max={hi} selectOnFocus
            disabled={disabled}
            value={((Number(value ?? z) - z) * k).toFixed(3)}
            onCommit={(v) => {
              const volts = clamp(Number(v), lo, hi);
              onChange(Math.min(0xFFFF, Math.max(0, Math.round(z + volts / k))));
            }}
          />
          <span className="unit">V</span>
        </span>
      );
    }
    const limit = geom.dc_offset_range_v / 2;
    return (
      <span className="field">
        <BlurInput
          type="number" step={0.005} min={-limit} max={limit} selectOnFocus
          disabled={disabled}
          value={dacToVolts(Number(value ?? geom.dc_offset_mid), geom).toFixed(3)}
          onCommit={(v) => onChange(voltsToDac(clamp(Number(v), -limit, limit), geom))}
        />
        <span className="unit">V</span>
      </span>
    );
  }

  return (
    <span className="field">
      <BlurInput
        type="number" min={def.min} max={def.max} selectOnFocus
        disabled={disabled}
        value={value ?? 0}
        onCommit={(v) => onChange(clamp(Number(v), def.min, def.max))}
      />
      {def.unit ? <span className="unit">{def.unit}</span> : null}
    </span>
  );
}
