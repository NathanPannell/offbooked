// The short fast-forward sound played where a stretch of other people's lines is left out
// (cuePlan.ts). Made in code, not recorded: noise swept up through a band pass, like tape spooling.
// This file is the same, byte for byte, in web/src/player and backend/src/track, so line by line and
// a listen track sound the same (backend/src/track/cuePlan.test.ts fails when they differ).

/** How long the sound lasts. */
export const SKIP_SOUND_MS = 400;
/** The sound and a breath after it: this takes the place of the pause before the line a skip lands on. */
export const SKIP_PAUSE_MS = 650;
/** Its peak: about -21 dBFS, far under speech at -16 LUFS, so it doesn't startle anyone in bed. */
export const SKIP_PEAK = 0.09;

/** The sound and its pause as samples from -1 to 1, the same every time. */
export function skipSamples(rate: number): Float32Array {
  const n = Math.round((rate * SKIP_SOUND_MS) / 1000);
  const out = new Float32Array(Math.round((rate * SKIP_PAUSE_MS) / 1000));
  let seed = 0x2545f491;
  const noise = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return ((seed >>> 0) / 4294967296) * 2 - 1;
  };
  let low = 0;
  let band = 0;
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const t = i / n;
    // A state-variable band pass sweeping from 400 Hz to 3.2 kHz.
    const f = Math.min(400 * Math.pow(8, t), rate / 6);
    const fc = 2 * Math.sin((Math.PI * f) / rate);
    low += fc * band;
    const high = noise() - low - 0.35 * band;
    band += fc * high;
    const envelope = Math.min(1, t / 0.1) * Math.min(1, (1 - t) / 0.35);
    out[i] = envelope * band;
    peak = Math.max(peak, Math.abs(out[i]!));
  }
  const gain = peak > 0 ? SKIP_PEAK / peak : 0;
  for (let i = 0; i < n; i++) out[i]! *= gain;
  return out;
}
