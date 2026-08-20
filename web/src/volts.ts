import type { Catalog } from "./types";

export type Geom = Catalog["geometry"];

/** The DC offset is a uint16 DAC word on the wire (that is what CAEN's API
 *  takes). Humans think in volts, so every human-facing control converts here
 *  and nowhere else. Midscale = no shift = 0 V.
 *
 *  The DAC spans +/-1 V while the ADC window is only 1 Vpp, and increasing the
 *  DAC LOWERS the baseline - both measured on the board, both the opposite of
 *  what the obvious guess would be. */
export function dacToVolts(dac: number, g: Geom) {
  return -((dac - g.dc_offset_mid) / g.dc_offset_mid) * (g.dc_offset_range_v / 2);
}

export function voltsToDac(v: number, g: Geom) {
  const dac = Math.round(g.dc_offset_mid * (1 - v / (g.dc_offset_range_v / 2)));
  return Math.min(g.dc_offset_max, Math.max(0, dac));
}

/** ADC counts per DAC LSB: negative, and the offset range is twice the window,
 *  so a full DAC sweep drags the baseline across the window twice over. */
function countsPerLsb(g: Geom) {
  return -(g.dc_offset_range_v / (g.dc_offset_max + 1)) * ((g.adc_max + 1) / g.input_range_vpp);
}

/** Where 0 V lands in ADC counts for a given DC offset. */
export function zeroCounts(dac: number, g: Geom) {
  return (g.adc_max + 1) / 2 + (dac - g.dc_offset_mid) * countsPerLsb(g);
}

export function voltsAtCount(counts: number, dac: number, g: Geom) {
  return (counts - zeroCounts(dac, g)) * (g.input_range_vpp / (g.adc_max + 1));
}

/** Signed volts, e.g. "+0.500 V". */
export function fmtV(v: number) {
  const mag = Math.abs(v) < 5e-4 ? "0.000" : Math.abs(v).toFixed(3);
  return (v < 0 ? "-" : "+") + mag + " V";
}
