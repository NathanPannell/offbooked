import { createReadStream } from "node:fs";

// Integrated loudness (ITU-R BS.1770 / EBU R128, the figure ffmpeg's loudnorm reports as input_i)
// of mono 48 kHz 16-bit samples, worked out in-process on audio we already have decoded, so
// normalizing a clip doesn't need a separate ffmpeg pass just to measure it. K-weighting (a high
// shelf, then a high-pass), mean square over 400 ms blocks every 100 ms, an absolute gate at
// -70 LUFS and a relative gate 10 LU below the blocks that pass it. Streaming: the filters keep
// two samples of state and the squares are summed into 100 ms buckets, so memory stays a few
// numbers per second of audio however long the take is.

const RATE = 48_000;
const BUCKET = RATE / 10; // 100 ms
// BS.1770-4 K-weighting coefficients at 48 kHz: [b0, b1, b2, a1, a2].
const SHELF = [1.53512485958697, -2.69169618940638, 1.19839281085285, -1.69065929318241, 0.73248077421585] as const;
const HIGHPASS = [1.0, -2.0, 1.0, -1.99004745483398, 0.99007225036621] as const;

const lufs = (meanSquare: number) => -0.691 + 10 * Math.log10(meanSquare);

/** Feeds samples in order; `result()` is the integrated loudness of everything fed. */
export class LoudnessMeter {
  // Biquad state: shelf, then high-pass.
  private s = [0, 0, 0, 0];
  private h = [0, 0, 0, 0];
  private bucket = 0;
  private inBucket = 0;
  private buckets: number[] = [];
  private count = 0;

  add(pcm: Int16Array): void {
    const [sb0, sb1, sb2, sa1, sa2] = SHELF;
    const [hb0, hb1, hb2, ha1, ha2] = HIGHPASS;
    let [sx1, sx2, sy1, sy2] = this.s as [number, number, number, number];
    let [hx1, hx2, hy1, hy2] = this.h as [number, number, number, number];
    for (let i = 0; i < pcm.length; i++) {
      const x = pcm[i]! / 32768;
      const y = sb0 * x + sb1 * sx1 + sb2 * sx2 - sa1 * sy1 - sa2 * sy2;
      sx2 = sx1;
      sx1 = x;
      sy2 = sy1;
      sy1 = y;
      const k = hb0 * y + hb1 * hx1 + hb2 * hx2 - ha1 * hy1 - ha2 * hy2;
      hx2 = hx1;
      hx1 = y;
      hy2 = hy1;
      hy1 = k;
      this.bucket += k * k;
      if (++this.inBucket === BUCKET) {
        this.buckets.push(this.bucket);
        this.bucket = 0;
        this.inBucket = 0;
      }
    }
    this.s = [sx1, sx2, sy1, sy2];
    this.h = [hx1, hx2, hy1, hy2];
    this.count += pcm.length;
  }

  /** LUFS, or null when nothing passes the gates (near silence). A clip shorter than one 400 ms block counts as one block. */
  result(): number | null {
    if (this.count === 0) return null;
    const blocks: number[] = [];
    if (this.buckets.length < 4) blocks.push((this.buckets.reduce((a, b) => a + b, 0) + this.bucket) / this.count);
    else
      for (let i = 0; i + 4 <= this.buckets.length; i++)
        blocks.push((this.buckets[i]! + this.buckets[i + 1]! + this.buckets[i + 2]! + this.buckets[i + 3]!) / (4 * BUCKET));
    const loud = blocks.filter((z) => z > 0 && lufs(z) > -70);
    if (!loud.length) return null;
    const relative = lufs(loud.reduce((a, b) => a + b, 0) / loud.length) - 10;
    const gated = loud.filter((z) => lufs(z) > relative);
    return gated.length ? lufs(gated.reduce((a, b) => a + b, 0) / gated.length) : null;
  }
}

/** Integrated loudness of samples [from, to) of 48 kHz mono audio in memory. */
export function integratedLoudness(pcm: Int16Array, from = 0, to = pcm.length): number | null {
  const meter = new LoudnessMeter();
  meter.add(pcm.subarray(Math.max(0, from), Math.min(pcm.length, to)));
  return meter.result();
}

/** Integrated loudness of samples [from, to) of a raw 48 kHz mono 16-bit file, read in chunks. */
export async function fileLoudness(file: string, from: number, to: number): Promise<number | null> {
  const meter = new LoudnessMeter();
  if (to <= from) return null;
  let carry: Buffer | null = null;
  for await (const chunk of createReadStream(file, { start: from * 2, end: to * 2 - 1, highWaterMark: 1 << 20 })) {
    let bytes: Buffer = carry ? Buffer.concat([carry, chunk as Buffer]) : (chunk as Buffer);
    carry = bytes.length % 2 ? bytes.subarray(bytes.length - 1) : null;
    if (carry) bytes = bytes.subarray(0, bytes.length - 1);
    // A copy keeps the samples aligned whatever offset the chunk has.
    const samples = new Int16Array(bytes.length / 2);
    for (let i = 0; i < samples.length; i++) samples[i] = bytes.readInt16LE(i * 2);
    meter.add(samples);
  }
  return meter.result();
}
