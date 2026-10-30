// The short "fast-forward" sound a listen track plays where the listener's "Skip to my cues" leaves
// out a stretch of other people's lines. Made here, not recorded: noise swept up through a band
// pass, like tape spooling, with a rising whirr under it. Keep in step with
// web/src/player/fastForward.ts, so line by line and the track sound the same.

/** How long the sound lasts. It replaces the pause before the line the skip lands on. */
export const FAST_FORWARD_MS = 700;

/** The sound as samples from -1 to 1, the same every time. */
export function fastForwardSamples(rate: number): Float32Array {
  const n = Math.round((rate * FAST_FORWARD_MS) / 1000);
  const out = new Float32Array(n);
  let seed = 0x2545f491;
  const noise = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return ((seed >>> 0) / 4294967296) * 2 - 1;
  };
  let low = 0;
  let band = 0;
  let phase = 0;
  let peak = 0;
  for (let i = 0; i < n; i++) {
    const t = i / n;
    // A state-variable band pass sweeping from 300 Hz to 3.6 kHz.
    const f = Math.min(300 * Math.pow(12, t), rate / 6);
    const fc = 2 * Math.sin((Math.PI * f) / rate);
    low += fc * band;
    const high = noise() - low - 0.35 * band;
    band += fc * high;
    // The spool's whirr: a tone rising from 180 Hz, fluttering 28 times a second.
    phase += (2 * Math.PI * 180 * Math.pow(5, t)) / rate;
    const whirr = Math.sin(phase) * (0.5 + 0.5 * Math.sin((2 * Math.PI * 28 * i) / rate));
    const envelope = Math.min(1, t / 0.08) * Math.min(1, (1 - t) / 0.3);
    out[i] = envelope * (0.55 * band + 0.18 * whirr);
    peak = Math.max(peak, Math.abs(out[i]!));
  }
  // Quieter than speech: a peak of about -9 dBFS.
  const gain = peak > 0 ? 0.35 / peak : 0;
  for (let i = 0; i < n; i++) out[i]! *= gain;
  return out;
}

/** The sound as raw mono 16-bit little-endian samples, as the track encoder takes them. */
export function fastForwardPcm(rate: number): Buffer {
  const samples = fastForwardSamples(rate);
  const buf = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) => buf.writeInt16LE(Math.round(s * 32767), i * 2));
  return buf;
}
