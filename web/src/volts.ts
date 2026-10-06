import type { Catalog } from "./types";

export type Geom = Catalog["geometry"];

/** Signal-channel DC offset: a uint16 DAC word on the wire, shown as the
 *  INPUT voltage at the centre of the 1 Vpp window (UM4270 rev 13 sec 9.1,
 *  Fig. 9.1: the DAC shifts the window +/-1 V, FSR/2 = bipolar). Raising the
 *  DAC raises the window, so a fixed input lands on a LOWER ADC code. */
export function dacToVolts(dac: number, g: Geom) {
  return ((dac - g.dc_offset_mid) / g.dc_offset_mid) * (g.dc_offset_range_v / 2);
}

export function voltsToDac(v: number, g: Geom) {
  const dac = Math.round(g.dc_offset_mid * (1 + v / (g.dc_offset_range_v / 2)));
  return Math.min(g.dc_offset_max, Math.max(0, dac));
}

/** ADC codes a fixed input moves per DAC LSB: negative (see dacToVolts). */
export function countsPerLsb(g: Geom) {
  return -(g.dc_offset_range_v / (g.dc_offset_max + 1)) * ((g.adc_max + 1) / g.input_range_vpp);
}

/** The MANUAL's threshold arithmetic (UM4270 rev 12 sec 9.8.3; the same
 *  worked examples are in the V1742 manual rev 6 sec 5.15, in docs/): the
 *  TR0 comparator spans 0-2.5 V behind a x2 input attenuator; its DAC moves
 *  13.2 counts per mV AT THE INPUT (the x2 is already folded in), and DAC
 *  0x6666 = 26214 is the signal's
 *  0-Volt WHEN THE TR DC OFFSET SITS AT MIDSCALE (0x8000). CAEN's worked
 *  example: a -400 mV NIM trigger is 26214 - 400*13.2 = 20934 - the value
 *  that worked here on day one. The manual states outright that no simple
 *  formula exists for other offset values, which is why the offset belongs
 *  at midscale and the UI warns when it is not. */
export const TR_THR_MID_DAC = 26214;
export const TR_THR_MV_PER_LSB = 1 / 13.2;
export const TR_OFF_MID_DAC = 32768;

/** TR0's digitized trace (UM4270 rev 13 sec 9.1.2): 2 Vpp at the input,
 *  attenuated x2 into the 1 Vpp DRS4 (mezzanine PCB rev >= 1; bit[9] of
 *  0x1n88 reads 1 on serial 53364). The TR DC offset shifts the window by
 *  1 V per 10240 DAC steps at the input - Tab. 9.1's TTL row, 0xA800 =
 *  32768 + 10240 centring a 0..2 V signal; a delta sweep on serial 53364
 *  agreed to 1%. The manual's "factor of 16" only places 32768 near code
 *  2048; read as a slope it is off by 3.2x. */
export const TR_ATTEN = 2;
export const TR_OFF_V_PER_LSB = 1 / 10240;

/** Input volts at the centre of TR0's window for a TR DC offset word. */
export function trOffsetV(dac: number): number {
  return (dac - TR_OFF_MID_DAC) * TR_OFF_V_PER_LSB;
}

/** ADC codes a fixed TR0 input moves per TR DC offset LSB (about -0.2). */
export function trCountsPerLsb(g: Geom): number {
  return -TR_OFF_V_PER_LSB * (g.adc_max + 1) / (g.input_range_vpp * TR_ATTEN);
}

export function trAbsThresholdV(thrDac: number): number {
  return ((thrDac - TR_THR_MID_DAC) * TR_THR_MV_PER_LSB) / 1000;
}

export function trThresholdDacForAbs(absV: number): number {
  const dac = Math.round(TR_THR_MID_DAC + (absV * 1000) / TR_THR_MV_PER_LSB);
  return Math.min(0xFFFF, Math.max(0, dac));
}

/** Shortest decimal text for a DAC-backed volts value that still maps back
 *  to the exact DAC word. A fixed toFixed(3) rounded to the mV, so the field
 *  quoted a value the register did not hold - and committing that text
 *  would have moved the register. */
export function fmtDacVolts(dac: number, toV: (d: number) => number,
                            toDac: (v: number) => number): string {
  const v = toV(dac);
  for (let d = 3; d <= 8; d++) {
    const s = v.toFixed(d);
    if (toDac(Number(s)) === dac) return s;
  }
  return String(v);
}

/** Where 0 V lands in ADC counts for a given DC offset. */
export function zeroCounts(dac: number, g: Geom) {
  return (g.adc_max + 1) / 2 + (dac - g.dc_offset_mid) * countsPerLsb(g);
}

export function voltsAtCount(counts: number, dac: number, g: Geom) {
  return (counts - zeroCounts(dac, g)) * (g.input_range_vpp / (g.adc_max + 1));
}

/** An ADC code relative to the window centre, in window volts (1 Vpp over
 *  4096 codes). Plots add the input scale and the DC offset on top of this:
 *  input V = scale * windowVolts(code) + window-centre volts. */
export function windowVolts(counts: number, g: Geom): number {
  return (counts - (g.adc_max + 1) / 2) / (g.adc_max + 1) * g.input_range_vpp;
}


/** A setting's own DAC<->volts line, when its catalog entry carries one
 *  (lsb_v/zero_dac - the TR path); the channel-input model otherwise. EVERY
 *  place that shows a volts-typed setting must convert through these two, or
 *  the field and the change toast quote different voltages for one DAC word. */
export function defDacToVolts(
  def: { lsb_v?: number; zero_dac?: number }, dac: number, g: Geom,
): number {
  if (def.lsb_v != null && def.zero_dac != null) {
    return (dac - def.zero_dac) * def.lsb_v;
  }
  return dacToVolts(dac, g);
}

export function defVoltsToDac(
  def: { lsb_v?: number; zero_dac?: number }, v: number, g: Geom,
): number {
  if (def.lsb_v != null && def.zero_dac != null) {
    return Math.min(0xFFFF, Math.max(0, Math.round(def.zero_dac + v / def.lsb_v)));
  }
  return voltsToDac(v, g);
}

/** A volts-typed setting's DAC word as exact field text (see fmtDacVolts). */
export function defFieldVolts(
  def: { lsb_v?: number; zero_dac?: number }, dac: number, g: Geom,
): string {
  return fmtDacVolts(dac, (d) => defDacToVolts(def, d, g),
                     (v) => defVoltsToDac(def, v, g));
}

/** Signed volts, e.g. "+0.500 V". */
export function fmtV(v: number) {
  const mag = Math.abs(v) < 5e-4 ? "0.000" : Math.abs(v).toFixed(3);
  return (v < 0 ? "-" : "+") + mag + " V";
}
