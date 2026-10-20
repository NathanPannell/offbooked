import { rmsDb, startVad, vadStep, type VadState } from "../stt/live";
import { MicError, type ActiveTake } from "./recorder";

/** The part of a mic session the mic test uses (MicSession in the app, a fake in tests). */
export interface TestMic {
  open(): Promise<void>;
  start(maxMs: number, onLimit: () => void): ActiveTake;
  close(): void;
}

/**
 * Records a short sample for the mic test: opens the mic (the browser may ask), records until
 * `wait(ms)` resolves (by default `ms`), and always closes the mic again, so the test never holds
 * it open. `onListening` fires once the mic is recording. Failures come back as a MicError, for MicHelp.
 */
export async function recordSample(
  mic: TestMic,
  ms: number,
  { onListening, wait = (t: number) => new Promise<void>((r) => setTimeout(r, t)) }: { onListening?: () => void; wait?: (ms: number) => Promise<void> } = {},
): Promise<Blob> {
  try {
    await mic.open();
    const take = mic.start(ms + 1000, () => {});
    onListening?.();
    await wait(ms);
    const clip = await take.stop();
    if (clip.blob.size === 0) throw new MicError("unknown", "The microphone didn't pick anything up.");
    return clip.blob;
  } catch (err) {
    throw err instanceof MicError ? err : new MicError("unknown", "The microphone didn't start.");
  } finally {
    mic.close();
  }
}

// The mic check listens until it has heard someone speak and then stop, so it can play them back
// straight away: no stop button, and no fixed few seconds to wait out.

/** The longest the mic check listens, speech or not. */
export const MIC_CHECK_MAX_MS = 6000;
/** Voice heard for this long counts as someone speaking (a cough or a tap doesn't)... */
export const MIC_CHECK_SPEECH_MS = 400;
/** ...and once they have been quiet this long after it, the check plays it back. */
export const MIC_CHECK_QUIET_MS = 700;

/** Whether the mic check has heard enough: speech and then a short quiet, or its time is up. */
export function micCheckDone(vad: VadState): boolean {
  return vad.elapsedMs >= MIC_CHECK_MAX_MS || (vad.speechMs >= MIC_CHECK_SPEECH_MS && vad.silenceMs >= MIC_CHECK_QUIET_MS);
}

/** A level for drawing, 0 to 1, from a block of samples: scaled so normal speech fills most of the height. */
export function drawLevel(samples: Float32Array): number {
  let sum = 0;
  for (const s of samples) sum += s * s;
  return Math.min(1, Math.sqrt(Math.sqrt(sum / Math.max(1, samples.length))) * 1.6);
}

/** Levels squeezed (or spread) into `bars` bars, each the loudest moment it covers. */
export function traceBars(levels: readonly number[], bars: number): number[] {
  if (bars <= 0 || levels.length === 0) return [];
  return Array.from({ length: bars }, (_, i) => {
    const from = Math.floor((i * levels.length) / bars);
    const to = Math.max(from + 1, Math.floor(((i + 1) * levels.length) / bars));
    let peak = 0;
    for (let k = from; k < to && k < levels.length; k++) peak = Math.max(peak, levels[k]!);
    return peak;
  });
}

export interface Listened {
  /** Someone spoke: more than a tap or the room. */
  heardVoice: boolean;
  /** How long it listened. */
  durationMs: number;
  /** Levels every POLL_MS, for drawing the clip as it plays back. */
  levels: number[];
}

const POLL_MS = 50;

/**
 * Listens on the mic's level meter until the mic check is done (see `micCheckDone`), or `maxMs`
 * without a meter. `signal` ends it early.
 */
export function listenForCheck(analyser: AnalyserNode | null, maxMs: number, signal?: AbortSignal): Promise<Listened> {
  return new Promise((resolve) => {
    const levels: number[] = [];
    const began = performance.now();
    if (!analyser) {
      // No meter to judge by (no Web Audio): listen the whole time and assume they spoke.
      const id = setTimeout(() => resolve({ heardVoice: true, durationMs: maxMs, levels }), maxMs);
      signal?.addEventListener("abort", () => {
        clearTimeout(id);
        resolve({ heardVoice: false, durationMs: performance.now() - began, levels });
      });
      return;
    }
    const buffer = new Float32Array(analyser.fftSize);
    let vad = startVad();
    let last = began;
    const id = setInterval(() => {
      const now = performance.now();
      analyser.getFloatTimeDomainData(buffer);
      vad = vadStep(vad, rmsDb(buffer), now - last);
      last = now;
      levels.push(drawLevel(buffer));
      if (micCheckDone(vad) || vad.elapsedMs >= maxMs || signal?.aborted) {
        clearInterval(id);
        resolve({ heardVoice: vad.speechMs >= MIC_CHECK_SPEECH_MS, durationMs: now - began, levels });
      }
    }, POLL_MS);
  });
}
