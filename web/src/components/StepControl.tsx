import { BlurInput } from "./BlurInput";

export interface Step { pct: number; ns: number }

interface Props {
  steps: Step[];
  value: number;                 // current percent
  onChange: (pct: number) => void;
}

/** A setting the hardware can only take certain values of.
 *
 *  The arrows walk the reachable values, so nothing unreachable is ever sent
 *  and the server never has to second-guess the request. Typing lands on the
 *  nearest reachable step, which the field shows straight away.
 *
 *  Shown in time, because a percentage that goes 24 -> 29 -> 33 reads as broken
 *  while the underlying register steps are perfectly regular. Where the trigger
 *  actually lands is shown on the channel charts, scope-style. */
export function StepControl({ steps, value, onChange }: Props) {
  const i = nearestIndex(steps, value, "pct");
  const cur = steps[i];

  const step = (delta: number) => {
    const j = Math.min(steps.length - 1, Math.max(0, i + delta));
    if (steps[j] && steps[j].pct !== value) onChange(steps[j].pct);
  };

  return (
    <span className="step-input">
        <span className="field">
          <BlurInput
            type="number" selectOnFocus
            value={cur ? cur.ns : 0}
            format={(raw) => String(steps[nearestIndex(steps, Number(raw || 0), "ns")].ns)}
            onCommit={(v) => {
              const j = nearestIndex(steps, Number(v || 0), "ns");
              if (steps[j].pct !== value) onChange(steps[j].pct);
            }}
          />
          <span className="unit">ns</span>
        </span>
        <span className="steppers">
          <button className="stepper" disabled={i >= steps.length - 1}
            onClick={() => step(1)} title="Next reachable setting"
            aria-label="increase">&#9652;</button>
          <button className="stepper" disabled={i <= 0}
            onClick={() => step(-1)} title="Previous reachable setting"
            aria-label="decrease">&#9662;</button>
      </span>
    </span>
  );
}

function nearestIndex(steps: Step[], v: number, key: "pct" | "ns") {
  let best = 0, dist = Infinity;
  steps.forEach((s, k) => {
    const d = Math.abs(s[key] - v);
    if (d < dist) { dist = d; best = k; }
  });
  return best;
}
