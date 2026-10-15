import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

// Finds where the voice starts and ends in a recording, so takes lose the fumbling before the
// first word and after the last (the tap, the breath in, the reach for the stop button) without
// clipping a word. Only the two ends are cut: nothing inside the speech is ever removed.
//
// The levels are relative to the clip itself: the noise floor is a low percentile of 10 ms frame
// levels and the speech level a high one, so a quiet phone in a quiet room and a loud one in a
// noisy room are judged the same way. A short spike (a tap or a click) never counts as speech.

export const TRIM = {
  frameMs: 10,
  analysisRate: 16_000,
  leadPadMs: 120, // kept before the first sound, so word onsets and the breath into them survive
  tailPadMs: 200, // kept after the last, for trailing consonants and the decay of the voice
  minRunMs: 40, // sound must last this long to count as speech (a click is 5–20 ms)
  minRangeDb: 10, // below this between floor and speech, the clip can't be told apart: keep it whole
} as const;

export interface SpeechBounds {
  startMs: number;
  endMs: number;
  thresholdDb: number;
  noiseDb: number;
  speechDb: number;
}

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))))]!;
}

/** Frame levels in dBFS (10 ms frames of 16-bit mono PCM). */
export function frameLevels(pcm: Int16Array, rate: number = TRIM.analysisRate, frameMs: number = TRIM.frameMs): number[] {
  const size = Math.max(1, Math.round((rate * frameMs) / 1000));
  const out: number[] = [];
  for (let i = 0; i < pcm.length; i += size) {
    const end = Math.min(pcm.length, i + size);
    let sum = 0;
    for (let j = i; j < end; j++) sum += pcm[j]! * pcm[j]!;
    const rms = Math.sqrt(sum / (end - i)) / 32768;
    out.push(rms > 0 ? Math.max(-100, 20 * Math.log10(rms)) : -100);
  }
  return out;
}

/**
 * The span to keep, from frame levels: from just before the first sustained sound to just after
 * the last, padded. Null when the clip has no clear speech above its floor (keep it whole).
 */
export function speechBounds(levels: number[], frameMs: number = TRIM.frameMs): SpeechBounds | null {
  if (levels.length === 0) return null;
  const sorted = [...levels].sort((a, b) => a - b);
  const noiseDb = percentile(sorted, 0.1);
  const speechDb = percentile(sorted, 0.95);
  if (speechDb - noiseDb < TRIM.minRangeDb) return null;
  // Low enough to catch soft onsets and endings, high enough to clear the room's hiss.
  const thresholdDb = Math.min(noiseDb + Math.max(6, 0.25 * (speechDb - noiseDb)), speechDb - 20);
  const minRun = Math.max(1, Math.ceil(TRIM.minRunMs / frameMs));
  let first = -1;
  let last = -1;
  let run = 0;
  for (let i = 0; i < levels.length; i++) {
    run = levels[i]! >= thresholdDb ? run + 1 : 0;
    if (run >= minRun) {
      if (first < 0) first = i - run + 1;
      last = i;
    }
  }
  if (first < 0) return null;
  const totalMs = levels.length * frameMs;
  const startMs = Math.max(0, first * frameMs - TRIM.leadPadMs);
  const endMs = Math.min(totalMs, (last + 1) * frameMs + TRIM.tailPadMs);
  return { startMs, endMs, thresholdDb, noiseDb, speechDb };
}

/** Decodes a clip to 16 kHz mono PCM and finds its speech. Null when it can't tell (keep it whole). */
export async function detectSpeech(file: string): Promise<SpeechBounds | null> {
  const { stdout } = await exec(
    "ffmpeg",
    ["-hide_banner", "-nostdin", "-i", file, "-vn", "-ac", "1", "-ar", String(TRIM.analysisRate), "-f", "s16le", "-acodec", "pcm_s16le", "-"],
    { encoding: "buffer", maxBuffer: 64 * 1024 * 1024, timeout: 2 * 60_000 },
  );
  const bytes = stdout as Buffer;
  const pcm = new Int16Array(Math.floor(bytes.length / 2));
  for (let i = 0; i < pcm.length; i++) pcm[i] = bytes.readInt16LE(i * 2);
  return speechBounds(frameLevels(pcm));
}
