// Integrated loudness (ITU-R BS.1770 / EBU R128, the figure ffmpeg's loudnorm reports as input_i)
// of mono 48 kHz samples, worked out in-process on audio we already have decoded, so normalizing a
// clip doesn't need a separate ffmpeg pass just to measure it. K-weighting (a high shelf, then a
// high-pass), mean square over 400 ms blocks every 100 ms, an absolute gate at -70 LUFS and a
// relative gate 10 LU below the blocks that pass it.

const RATE = 48_000;
// BS.1770-4 K-weighting coefficients at 48 kHz: [b0, b1, b2, a1, a2].
const SHELF = [1.53512485958697, -2.69169618940638, 1.19839281085285, -1.69065929318241, 0.73248077421585] as const;
const HIGHPASS = [1.0, -2.0, 1.0, -1.99004745483398, 0.99007225036621] as const;

function biquad(x: Float64Array, [b0, b1, b2, a1, a2]: readonly number[]): Float64Array {
  const y = new Float64Array(x.length);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = b0! * x[i]! + b1! * x1 + b2! * x2 - a1! * y1 - a2! * y2;
    x2 = x1;
    x1 = x[i]!;
    y2 = y1;
    y1 = v;
    y[i] = v;
  }
  return y;
}

const lufs = (meanSquare: number) => -0.691 + 10 * Math.log10(meanSquare);

/**
 * Integrated loudness in LUFS of 48 kHz mono samples [from, to) (16-bit, as decoded), or null when
 * nothing passes the gates (near silence). A clip shorter than one 400 ms block counts as one block.
 */
export function integratedLoudness(pcm: Int16Array, from = 0, to = pcm.length): number | null {
  const n = Math.max(0, Math.min(pcm.length, to) - Math.max(0, from));
  if (n === 0) return null;
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) x[i] = pcm[from + i]! / 32768;
  const k = biquad(biquad(x, SHELF), HIGHPASS);
  const block = Math.round(RATE * 0.4);
  const hop = Math.round(RATE * 0.1);
  // Running sums of squares, so each block is two lookups.
  const sums = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) sums[i + 1] = sums[i]! + k[i]! * k[i]!;
  const blocks: number[] = [];
  if (n < block) blocks.push(sums[n]! / n);
  else for (let s = 0; s + block <= n; s += hop) blocks.push((sums[s + block]! - sums[s]!) / block);
  const loud = blocks.filter((z) => z > 0 && lufs(z) > -70);
  if (!loud.length) return null;
  const relative = lufs(loud.reduce((a, b) => a + b, 0) / loud.length) - 10;
  const gated = loud.filter((z) => lufs(z) > relative);
  if (!gated.length) return null;
  return lufs(gated.reduce((a, b) => a + b, 0) / gated.length);
}
