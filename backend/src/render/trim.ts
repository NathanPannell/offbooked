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
  pauseMs: 150, // a quiet gap this long inside the speech splits it into two stretches (see speechStretches)
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
  const l = levelsOf(levels);
  if (!l) return null;
  const runs = soundRuns(levels, l.thresholdDb, frameMs);
  if (runs.length === 0) return null;
  const totalMs = levels.length * frameMs;
  const startMs = Math.max(0, runs[0]![0] * frameMs - TRIM.leadPadMs);
  const endMs = Math.min(totalMs, (runs[runs.length - 1]![1] + 1) * frameMs + TRIM.tailPadMs);
  return { startMs, endMs, ...l };
}

/** The clip's own levels: its noise floor, its speech level and the threshold between them. Null when they can't be told apart. */
function levelsOf(levels: number[]): { thresholdDb: number; noiseDb: number; speechDb: number } | null {
  if (levels.length === 0) return null;
  const sorted = [...levels].sort((a, b) => a - b);
  const noiseDb = percentile(sorted, 0.1);
  const speechDb = percentile(sorted, 0.95);
  if (speechDb - noiseDb < TRIM.minRangeDb) return null;
  // Low enough to catch soft onsets and endings, high enough to clear the room's hiss.
  const thresholdDb = Math.min(noiseDb + Math.max(6, 0.25 * (speechDb - noiseDb)), speechDb - 20);
  return { thresholdDb, noiseDb, speechDb };
}

/** Runs of sustained sound (at least TRIM.minRunMs) above the threshold, as [first, last] frame indices. */
function soundRuns(levels: number[], thresholdDb: number, frameMs: number): [number, number][] {
  const minRun = Math.max(1, Math.ceil(TRIM.minRunMs / frameMs));
  const runs: [number, number][] = [];
  let run = 0;
  for (let i = 0; i <= levels.length; i++) {
    if (i < levels.length && levels[i]! >= thresholdDb) {
      run++;
      continue;
    }
    if (run >= minRun) runs.push([i - run, i - 1]);
    run = 0;
  }
  return runs;
}

export interface Stretch {
  startMs: number;
  endMs: number;
}

/**
 * Where the voice is, from frame levels, judged like the trim (the same floor, threshold and
 * minimum run): sustained sound, split wherever it stops for TRIM.pauseMs or more, so a word after
 * a pause starts a new stretch while the short gaps between words don't. Empty when the clip has
 * no clear speech.
 */
export function speechStretches(levels: number[], frameMs: number = TRIM.frameMs): Stretch[] {
  const l = levelsOf(levels);
  if (!l) return [];
  const out: Stretch[] = [];
  for (const [first, last] of soundRuns(levels, l.thresholdDb, frameMs)) {
    const startMs = first * frameMs;
    const endMs = (last + 1) * frameMs;
    const prev = out[out.length - 1];
    if (prev && startMs - prev.endMs < TRIM.pauseMs) prev.endMs = endMs;
    else out.push({ startMs, endMs });
  }
  return out;
}

/** Stretches moved onto a cut of the clip that starts at `startMs` and lasts `lengthMs`. */
export function shiftStretches(stretches: readonly Stretch[], startMs: number, lengthMs: number): Stretch[] {
  return stretches.flatMap((s) => {
    const from = Math.max(0, s.startMs - startMs);
    const to = Math.min(lengthMs, s.endMs - startMs);
    return to > from ? [{ startMs: Math.round(from), endMs: Math.round(to) }] : [];
  });
}

/** A clip's speech: where the trim cuts it, and where the voice is (in ms of the uncut clip). */
export interface SpeechAnalysis {
  bounds: SpeechBounds | null;
  stretches: Stretch[];
}

/** Decodes a clip to 16 kHz mono PCM and finds its speech. Null when it can't tell (keep it whole). */
export async function detectSpeech(file: string): Promise<SpeechBounds | null> {
  return (await analyzeSpeech(file)).bounds;
}

/** Decodes a clip to 16 kHz mono PCM once and finds both its trim and its stretches of voice. */
export async function analyzeSpeech(file: string): Promise<SpeechAnalysis> {
  const { stdout } = await exec(
    "ffmpeg",
    ["-hide_banner", "-nostdin", "-i", file, "-vn", "-ac", "1", "-ar", String(TRIM.analysisRate), "-f", "s16le", "-acodec", "pcm_s16le", "-"],
    { encoding: "buffer", maxBuffer: 64 * 1024 * 1024, timeout: 2 * 60_000 },
  );
  const bytes = stdout as Buffer;
  const pcm = new Int16Array(Math.floor(bytes.length / 2));
  for (let i = 0; i < pcm.length; i++) pcm[i] = bytes.readInt16LE(i * 2);
  const levels = frameLevels(pcm);
  return { bounds: speechBounds(levels), stretches: speechStretches(levels) };
}
