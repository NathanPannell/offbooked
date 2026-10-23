// Replays recorded takes through the live logic, to measure when it would end each one. A fixture
// take (`fixtures/live-takes.json`) is a spoken line with known timing: 20 ms mic levels, and every
// pass the speech model made over it, paced and windowed as `useLiveTake` paces them, each with when
// its answer came back (at desktop speed, and with latencies 3× and 5× longer, as on slower phones).
// The replay feeds levels and answers in time order through the same pure functions the hook uses,
// and reports when the take would have ended: before the line was over (a false end), or how long
// after it.

import { advanceInput, applyPass, clauseBreaks, decideAdvance, segmentLine, startProgress, startVad, vadStep } from "./live";

export interface ReplayPass {
  /** The audio the pass heard, in ms of the take. */
  fromMs: number;
  toMs: number;
  windowed: boolean;
  text: string;
  /** When its answer came back. */
  doneAtMs: number;
}

export interface ReplayTake {
  id: string;
  /** The line as written in the script. */
  text: string;
  speechStartMs: number;
  /** When the last word ends. */
  speechEndMs: number;
  /** Pauses inside the line, [start, end] ms. */
  beats: [number, number][];
  totalMs: number;
  /** Mic level of each 20 ms frame, dBFS. */
  frameDb: number[];
  /** The model's passes, by speed ("x1", "x3", "x5"). */
  schedules: Record<string, ReplayPass[]>;
}

export interface ReplayResult {
  take: string;
  speed: string;
  /** When the take would have ended, or null if it never did. */
  endedAtMs: number | null;
  /** How long after the last word it ended (negative: before, a false end). */
  afterEndMs: number | null;
  cursor: number;
  tokens: number;
}

const FRAME_MS = 20;
/** The capture posts 100 ms blocks, and the hook decides once per block. */
const FRAMES_PER_BLOCK = 5;

/** Replays one take with one schedule of passes. */
export function replayTake(take: ReplayTake, passes: readonly ReplayPass[]): { endedAtMs: number | null; cursor: number; tokens: number } {
  const { tokens } = segmentLine(take.text);
  const breaks = clauseBreaks(take.text);
  let progress = startProgress(tokens.length);
  let vad = startVad();
  let coveredMs = 0;
  let coveredSpeechMs = 0;
  let next = 0;
  /** Voiced time up to the end of each frame, as the VAD had it then. */
  const speechAt: number[] = [];
  for (let f = 0; f < take.frameDb.length; f++) {
    vad = vadStep(vad, take.frameDb[f]!, FRAME_MS);
    speechAt.push(vad.speechMs);
    if ((f + 1) % FRAMES_PER_BLOCK !== 0) continue;
    const now = (f + 1) * FRAME_MS;
    while (next < passes.length && passes[next]!.doneAtMs <= now) {
      const pass = passes[next++]!;
      progress = applyPass(progress, tokens, pass.text, pass.windowed);
      coveredMs = pass.toMs;
      coveredSpeechMs = speechAt[Math.min(speechAt.length - 1, Math.floor(pass.toMs / FRAME_MS) - 1)] ?? 0;
    }
    if (decideAdvance(advanceInput({ mode: "live", tokens: tokens.length, breaks, progress, vad, coveredMs, coveredSpeechMs })) === "advance") {
      return { endedAtMs: now, cursor: progress.cursor, tokens: tokens.length };
    }
  }
  return { endedAtMs: null, cursor: progress.cursor, tokens: tokens.length };
}

export function replayAll(takes: readonly ReplayTake[]): ReplayResult[] {
  return takes.flatMap((take) =>
    Object.entries(take.schedules).map(([speed, passes]) => {
      const r = replayTake(take, passes);
      return { take: take.id, speed, ...r, afterEndMs: r.endedAtMs === null ? null : r.endedAtMs - take.speechEndMs };
    }),
  );
}

export interface ReplaySummary {
  runs: number;
  /** Ended before the line was over. */
  falseEnds: number;
  /** Never ended. */
  stuck: number;
  /** After the last word, for takes that ended after it. */
  meanAfterEndMs: number;
  medianAfterEndMs: number;
  maxAfterEndMs: number;
}

export function summarizeReplay(results: readonly ReplayResult[]): ReplaySummary {
  const after = results.flatMap((r) => (r.afterEndMs !== null && r.afterEndMs >= 0 ? [r.afterEndMs] : [])).sort((a, b) => a - b);
  return {
    runs: results.length,
    falseEnds: results.filter((r) => r.afterEndMs !== null && r.afterEndMs < 0).length,
    stuck: results.filter((r) => r.endedAtMs === null).length,
    meanAfterEndMs: after.length ? Math.round(after.reduce((a, b) => a + b, 0) / after.length) : 0,
    medianAfterEndMs: after.length ? after[Math.floor(after.length / 2)]! : 0,
    maxAfterEndMs: after.length ? after[after.length - 1]! : 0,
  };
}
