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
//
// Loud enough isn't enough at the two ends, though. A hands-free take has the actor's breath in
// before the line, the exhale after it, and, near the end of the auto-advance pause, the breath for
// the next line: all well above the floor, so cutting at the first and last sound kept up to 2.7 s
// of dead air. So the ends are anchored on voiced sound (it repeats at a pitch; breath, hiss,
// clicks and bumps never do), widened only by the unvoiced sound joined to it (an "s" before the
// vowel, a final "t"). Measured on hands-free fixtures (room noise, breaths, a bump): 98 ms kept
// before the first word and 170 ms after the last on average (373 ms and 1,334 ms before).

export const TRIM = {
  frameMs: 10,
  analysisRate: 16_000,
  leadPadMs: 150, // kept before the first word's sound, for the softest part of its onset
  tailPadMs: 180, // kept after the last word's, for the decay of the voice
  minRunMs: 40, // sound must last this long to count as speech (a click is 5–20 ms)
  minRangeDb: 10, // below this between floor and speech, the clip can't be told apart: keep it whole
  pauseMs: 150, // a quiet gap this long inside the speech splits it into two stretches (see speechStretches)
  voicedRunMs: 50, // periodic sound this long is a voice (a vowel); breaths, clicks and bumps never are
  voicing: 0.6, // normalized autocorrelation at the pitch period (60–400 Hz) that counts as voiced
  valley: 0.3, // how far it must have dipped at shorter lags first (noise only fades, a pitch comes back)
  onsetMs: 300, // sound joined to the first voiced part (an "s", "f" or "th" before the vowel) kept, at most
  releaseMs: 250, // and joined to the last (a final "s" or "t", the voice dying away)
  closureMs: 120, // a quiet gap this short beside the voice is a stop's closure ("s|peak", "fact|s"), not a pause
  neighbourDb: 15, // sound across such a gap counts with the word when it is within this of the speech level (an "s" is; a breath isn't)
  loudDb: 12, // after the last voiced part, sound this close to the speech level is still the line (a word said too fast to show its pitch)
  loudGapMs: 300, // ...in the same run, or in one starting this soon after
  wordNearMs: 400, // with word starts: sound ending more than this before the first word isn't the line
  lineGapMs: 400, // ...nor sound after the last word's start once a quiet gap this long has passed
  minLastWordMs: 150, // the cut never ends sooner than this after the last word starts
  maxVoicingScanMs: 120_000, // the pitch check looks at no more sound than this (from both ends together) before falling back to the sound itself
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
 * The span to keep, from frame levels: from just before the first word to just after the last,
 * padded. With `voiced` (whether a frame is periodic, see `voicing`), the words are the sound that
 * has a voice in it, with the unvoiced sound joined to it (up to TRIM.onsetMs before and
 * TRIM.releaseMs after): a breath in before the line, the exhale after it, the breath for the next
 * line and any bump in the pause are sound, but have no voice, so they're cut. Without it, or when
 * nothing is voiced (a whisper), the first and last sustained sound. Null when the clip has no clear
 * speech above its floor (keep it whole).
 */
export function speechBounds(levels: number[], frameMs: number = TRIM.frameMs, voiced?: (frame: number) => boolean): SpeechBounds | null {
  const l = levelsOf(levels);
  if (!l) return null;
  const runs = soundRuns(levels, l.thresholdDb, frameMs);
  if (runs.length === 0) return null;
  const totalMs = levels.length * frameMs;
  const span = (voiced && voicedSpan(runs, voiced, frameMs, levels, l.speechDb)) ?? [runs[0]![0], runs[runs.length - 1]![1]];
  const startMs = Math.max(0, span[0] * frameMs - TRIM.leadPadMs);
  const endMs = Math.min(totalMs, (span[1] + 1) * frameMs + TRIM.tailPadMs);
  return { startMs, endMs, ...l };
}

/** When the line's first and last words start (ms of the clip), from following the take live or re-timing it. */
export interface WordAnchors {
  firstMs: number;
  lastMs: number;
}

/**
 * The line's words for a clip, given where its voice is (stretches of sound with a voice in them,
 * ms of the clip): when the first and last words start, or null when they aren't known.
 */
export type WordsOnVoice = (voice: Stretch[]) => WordAnchors | null;

/** The stretches with a voice in them (a voiced run of TRIM.voicedRunMs): breaths, bumps and scrapes left out. */
function voicedStretches(stretches: Stretch[], voiced: (frame: number) => boolean, frameMs: number): Stretch[] {
  const need = Math.max(1, Math.round(TRIM.voicedRunMs / frameMs));
  let budget = Math.round(TRIM.maxVoicingScanMs / frameMs);
  return stretches.filter((s) => {
    let n = 0;
    for (let i = Math.floor(s.startMs / frameMs); i < Math.ceil(s.endMs / frameMs); i++) {
      // Past the pitch check's budget, a stretch counts as voice: never leave speech out.
      if (--budget < 0) return true;
      n = voiced(i) ? n + 1 : 0;
      if (n >= need) return true;
    }
    return false;
  });
}

/**
 * The span to keep, anchored on the line's words rather than on loudness: only the sound runs of
 * the line count, from the first one reaching within TRIM.wordNearMs before the first word, through
 * every run starting up to TRIM.wordNearMs after the last word's start (a beat inside the line is
 * kept, however long), then on
 * while the gaps stay shorter than TRIM.lineGapMs: the silence after the last word ends it. Within
 * those runs the ends are found as `speechBounds` finds them (voiced, an unvoiced onset or release,
 * a stop's closure), so the cut sits on the voice just before the first word and just after the
 * last. A bump, a cough, a "hmm" or anyone speaking seconds before the line, or a scrape or an
 * "okay" after it, never moves the cut. The cut never ends before TRIM.minLastWordMs into the last
 * word. Null when the clip has no clear speech or no sound near the words (then `speechBounds`).
 */
export function wordBounds(levels: number[], words: WordAnchors, frameMs: number = TRIM.frameMs, voiced?: (frame: number) => boolean): SpeechBounds | null {
  const l = levelsOf(levels);
  if (!l) return null;
  const runs = soundRuns(levels, l.thresholdDb, frameMs);
  const first = Math.floor(words.firstMs / frameMs);
  const last = Math.floor(words.lastMs / frameMs);
  const near = Math.round(TRIM.wordNearMs / frameMs);
  const gap = Math.round(TRIM.lineGapMs / frameMs);
  const from = runs.findIndex((r) => r[1] >= first - near);
  if (from < 0 || runs[from]![0] > last + gap) return null;
  const line: [number, number][] = [];
  for (let k = from; k < runs.length; k++) {
    const r = runs[k]!;
    // A run starting just after the last word's anchor is still the line (the anchor may be early).
    if (r[0] > last + near && r[0] - line[line.length - 1]![1] - 1 > gap) break;
    line.push(r);
  }
  const span = (voiced && voicedSpan(line, voiced, frameMs, levels, l.speechDb)) ?? [line[0]![0], line[line.length - 1]![1]];
  const end = Math.max(span[1], Math.min(levels.length - 1, last + Math.round(TRIM.minLastWordMs / frameMs)));
  const totalMs = levels.length * frameMs;
  return { startMs: Math.max(0, span[0] * frameMs - TRIM.leadPadMs), endMs: Math.min(totalMs, (end + 1) * frameMs + TRIM.tailPadMs), ...l };
}

/**
 * From the first voiced stretch (TRIM.voicedRunMs) to the last, as [first, last] frames, widened
 * by at most TRIM.onsetMs before and TRIM.releaseMs after: to the sound run it sits in, and across
 * a stop's closure (TRIM.closureMs) to a run as loud as speech, so an "s" split off by the
 * silence of a "p", "t" or "k" stays with its word while a breath, quieter, doesn't. Null when no
 * run has a voice in it.
 */
function voicedSpan(
  runs: [number, number][],
  voiced: (frame: number) => boolean,
  frameMs: number,
  levels: number[],
  speechDb: number,
): [number, number] | null {
  const closure = Math.round(TRIM.closureMs / frameMs);
  const loud = ([a, b]: [number, number]) => {
    for (let i = a; i <= b; i++) if (levels[i]! >= speechDb - TRIM.neighbourDb) return true;
    return false;
  };
  const need = Math.max(1, Math.round(TRIM.voicedRunMs / frameMs));
  // The pitch check costs about 50 µs a frame: past this many frames looked at from the two ends without
  // finding a voice (minutes of whisper, or rain on the mic), the sound-based ends are used instead.
  let budget = Math.round(TRIM.maxVoicingScanMs / frameMs);
  const isVoiced = (i: number) => {
    if (--budget < 0) throw SCAN_SPENT;
    return voiced(i);
  };
  const firstIn = ([a, b]: [number, number]) => {
    let n = 0;
    for (let i = a; i <= b; i++) {
      n = isVoiced(i) ? n + 1 : 0;
      if (n === need) return i - need + 1;
    }
    return -1;
  };
  const lastIn = ([a, b]: [number, number]) => {
    let n = 0;
    for (let i = b; i >= a; i--) {
      n = isVoiced(i) ? n + 1 : 0;
      if (n === need) return i + need - 1;
    }
    return -1;
  };
  try {
    return spanOf(runs, firstIn, lastIn, loud, frameMs, levels, speechDb, closure);
  } catch (err) {
    if (err === SCAN_SPENT) return null;
    throw err;
  }
}

const SCAN_SPENT = new Error("voicing scan spent");

function spanOf(
  runs: [number, number][],
  firstIn: (run: [number, number]) => number,
  lastIn: (run: [number, number]) => number,
  loud: (run: [number, number]) => boolean,
  frameMs: number,
  levels: number[],
  speechDb: number,
  closure: number,
): [number, number] | null {
  let start: number | null = null;
  for (let r = 0; r < runs.length; r++) {
    const at = firstIn(runs[r]!);
    if (at < 0) continue;
    const earliest = at - Math.round(TRIM.onsetMs / frameMs);
    start = Math.max(runs[r]![0], earliest);
    for (let k = r - 1; k >= 0 && runs[k]![1] >= earliest && start - runs[k]![1] - 1 <= closure && loud(runs[k]!); k--) start = Math.max(runs[k]![0], earliest);
    break;
  }
  if (start === null) return null;
  for (let r = runs.length - 1; r >= 0; r--) {
    const at = lastIn(runs[r]!);
    if (at < 0) continue;
    const latest = at + Math.round(TRIM.releaseMs / frameMs);
    let end = Math.min(runs[r]![1], latest);
    for (let k = r + 1; k < runs.length && runs[k]![0] <= latest && runs[k]![0] - end - 1 <= closure && loud(runs[k]!); k++)
      end = Math.max(end, Math.min(runs[k]![1], latest));
    // Loud sound further on, in the same run or one just after, is speech the pitch check missed:
    // an exhale is quieter, and the breath for the next line comes much later.
    const loudGap = Math.round(TRIM.loudGapMs / frameMs);
    for (let k = r; k < runs.length && (k === r || runs[k]![0] - end - 1 <= loudGap); k++) {
      for (let i = runs[k]![1]; i > end && i >= runs[k]![0]; i--) {
        if (levels[i]! >= speechDb - TRIM.loudDb) {
          end = i;
          break;
        }
      }
    }
    return [start, end];
  }
  return null;
}

/**
 * Whether each 10 ms frame of 16 kHz PCM is voiced: its 30 ms window, at 8 kHz, repeats at a pitch
 * between 60 and 400 Hz (normalized autocorrelation of at least TRIM.voicing at that period, after
 * falling at least TRIM.valley below it at shorter lags). Breath, hiss, clicks and bumps never
 * repeat like that, and rumble or pink room noise, which looks alike from one ms to the next, only
 * fades with the lag: it never dips and comes back. Worked out only for frames asked about, once
 * each: a take costs a few ms, and at most TRIM.maxVoicingScanMs of sound is ever checked.
 */
export function voicing(pcm: Int16Array, rate: number = TRIM.analysisRate, frameMs: number = TRIM.frameMs): (frame: number) => boolean {
  // At 8 kHz: a voice's pitch and its first harmonics are all well below 4 kHz. (No pre-emphasis:
  // it takes away most of a low voice's fundamental and, with it, the repeats to find.)
  const step = Math.max(1, Math.round(rate / 8000));
  const low = new Float32Array(Math.floor(pcm.length / step));
  for (let i = 0; i < low.length; i++) {
    let sum = 0;
    for (let k = 0; k < step; k++) sum += pcm[i * step + k]!;
    low[i] = sum / step;
  }
  const lowRate = rate / step;
  const hop = (lowRate * frameMs) / 1000;
  const size = Math.round(lowRate * 0.03);
  const minLag = Math.floor(lowRate / 400);
  const maxLag = Math.ceil(lowRate / 60);
  const cache = new Map<number, boolean>();
  return (frame) => {
    const known = cache.get(frame);
    if (known !== undefined) return known;
    const from = Math.round(frame * hop + hop / 2 - size / 2);
    let result = false;
    if (from >= 0 && from + size + maxLag <= low.length) {
      let mean = 0;
      for (let i = from; i < from + size + maxLag; i++) mean += low[i]!;
      mean /= size + maxLag;
      let e0 = 0;
      for (let i = from; i < from + size; i++) e0 += (low[i]! - mean) ** 2;
      // From the shortest lags, so a high voice's dip (half its period) is seen too.
      let best = 0;
      let depth = 0;
      let lowest = 1;
      for (let lag = 2; lag <= maxLag && e0 > 0; lag++) {
        let cross = 0;
        let e1 = 0;
        for (let i = from; i < from + size; i++) {
          const a = low[i]! - mean;
          const b = low[i + lag]! - mean;
          cross += a * b;
          e1 += b * b;
        }
        const r = e1 > 0 ? cross / Math.sqrt(e0 * e1) : 0;
        lowest = Math.min(lowest, r);
        if (lag >= minLag && r > best) {
          best = r;
          depth = r - lowest;
        }
      }
      result = best >= TRIM.voicing && depth >= TRIM.valley;
    }
    cache.set(frame, result);
    return result;
  };
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
  /** The bounds come from the line's words (`wordBounds`), not loudness alone. */
  byWords?: boolean;
}

/** Decodes a clip to 16 kHz mono PCM and finds its speech. Null when it can't tell (keep it whole). */
export async function detectSpeech(file: string): Promise<SpeechBounds | null> {
  return (await analyzeSpeech(file)).bounds;
}

/** Decodes a clip to 16 kHz mono PCM once and finds both its trim and its stretches of voice. */
export async function analyzeSpeech(file: string, words?: WordsOnVoice | null): Promise<SpeechAnalysis> {
  const { stdout } = await exec(
    "ffmpeg",
    ["-hide_banner", "-nostdin", "-i", file, "-vn", "-ac", "1", "-ar", String(TRIM.analysisRate), "-f", "s16le", "-acodec", "pcm_s16le", "-"],
    { encoding: "buffer", maxBuffer: 64 * 1024 * 1024, timeout: 2 * 60_000 },
  );
  const bytes = stdout as Buffer;
  const pcm = new Int16Array(Math.floor(bytes.length / 2));
  for (let i = 0; i < pcm.length; i++) pcm[i] = bytes.readInt16LE(i * 2);
  const levels = frameLevels(pcm);
  const voiced = voicing(pcm);
  const stretches = speechStretches(levels);
  // The line's words when they're known, laid on the voice; loudness (and voice) alone otherwise.
  const anchors = words ? words(voicedStretches(stretches, voiced, TRIM.frameMs)) : null;
  const byWords = anchors ? wordBounds(levels, anchors, TRIM.frameMs, voiced) : null;
  return { bounds: byWords ?? speechBounds(levels, TRIM.frameMs, voiced), stretches, byWords: !!byWords };
}
