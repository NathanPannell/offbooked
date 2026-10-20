// When each word of a take was said, worked out while it records, so the run-through can light up
// words as the take plays instead of spreading them evenly over the clip. The live take feeds it
// mic levels and transcription passes.
//
// The speech model gives no word timestamps, only text. What we do know is which words the live
// cursor first passed in each pass, and which stretch of audio that pass heard. So each word is
// first placed inside the audio of the pass that reached it: from where the pass before it ended
// (a little earlier when the actor was mid-word at that moment, so a word cut off at the edge of
// that pass keeps its start) to where this pass's audio ended. That is when the audio was taken,
// not when the answer came back, so the pass's latency doesn't count, and a windowed pass never
// reaches back before its window. Then, within that, words go on the voiced time only, by length:
// a word starts while the actor is speaking, never in a pause, and a word after a pause starts
// where the voice comes back. All pure, except
// that `addVoiced` grows its list in place (it runs every 20 ms of a take).

import { lineTokens } from "../player/words";
import { segmentLine } from "./live";

/** Voiced time in a take, in ms of the take. */
export interface Stretch {
  startMs: number;
  endMs: number;
}

/** A gap shorter than this inside speech is the space between two words, not a pause. */
export const STRETCH_GAP_MS = 150;
/** How far before the previous pass's end a newly reached word may have started, when the voice ran across that end. */
export const PASS_SLACK_MS = 300;
/** The first word placed this close after the start of a voiced stretch starts with it. */
export const SNAP_MS = 120;
/** A word reached by a later pass starts at least this long after the word before it. */
export const MIN_WORD_MS = 80;

/** Adds voiced time [startMs, endMs] to the stretches, joining it to the last one across a short gap. */
export function addVoiced(stretches: Stretch[], startMs: number, endMs: number, gapMs = STRETCH_GAP_MS): Stretch[] {
  if (endMs <= startMs) return stretches;
  const last = stretches[stretches.length - 1];
  if (last && startMs <= last.endMs + gapMs) {
    if (endMs > last.endMs) stretches[stretches.length - 1] = { startMs: Math.min(last.startMs, startMs), endMs };
    return stretches;
  }
  stretches.push({ startMs, endMs });
  return stretches;
}

/** Which words a pass reached first, and the audio that pass heard: [fromMs, toMs] of the take. */
export interface PassReach {
  /** Tokens [first, last) were first reached by this pass. */
  first: number;
  last: number;
  fromMs: number;
  toMs: number;
  /** Where the audio of the pass before ended: the words were (mostly) said after it. */
  afterMs: number;
}

export interface WordClock {
  reaches: PassReach[];
  /** End of the audio the previous pass heard. */
  lastToMs: number;
}

export function startWordClock(): WordClock {
  return { reaches: [], lastToMs: 0 };
}

/**
 * Notes one finished pass: the cursor moved from `before` to `after`, and the pass heard the take's
 * audio from `fromMs` (a windowed pass starts late) to `toMs`.
 */
export function notePass(clock: WordClock, before: number, after: number, fromMs: number, toMs: number): WordClock {
  const reaches =
    after > before ? [...clock.reaches, { first: before, last: after, fromMs: Math.max(0, fromMs), toMs, afterMs: clock.lastToMs }] : clock.reaches;
  return { reaches, lastToMs: Math.max(clock.lastToMs, toMs) };
}

/** A token's share of the time: its letters, and a little more (as the run-through weighs words). */
const weight = (token: string) => 1.5 + token.length;

/** The stretches inside [fromMs, toMs]. */
function clip(stretches: readonly Stretch[], fromMs: number, toMs: number): Stretch[] {
  const out: Stretch[] = [];
  for (const s of stretches) {
    const startMs = Math.max(s.startMs, fromMs);
    const endMs = Math.min(s.endMs, toMs);
    if (endMs > startMs) out.push({ startMs, endMs });
  }
  return out;
}

/** The moment `offset` ms into the voiced time of `voiced`; an offset at a stretch's end is the next stretch's start. */
function atVoiced(voiced: readonly Stretch[], offset: number): number {
  let left = offset;
  for (let i = 0; i < voiced.length; i++) {
    const s = voiced[i]!;
    const length = s.endMs - s.startMs;
    if (left < length || i === voiced.length - 1) return s.startMs + Math.min(left, length);
    left -= length;
  }
  return 0;
}

/**
 * When each token (of `segmentLine`) starts, in ms of the take, or null when no pass reached any
 * word (there's nothing better to say than the voiced stretches themselves). Tokens the cursor
 * never reached share the last pass's audio, up to the end of the voice, with the words it did.
 */
export function tokenStarts(clock: WordClock, stretches: readonly Stretch[], tokens: readonly string[], endMs: number): number[] | null {
  if (clock.reaches.length === 0 || tokens.length === 0) return null;
  const groups = clock.reaches.map((r) => ({ ...r }));
  const last = groups[groups.length - 1]!;
  if (last.last < tokens.length) {
    last.last = tokens.length;
    const voiceEnd = stretches.length ? stretches[stretches.length - 1]!.endMs : last.toMs;
    last.toMs = Math.max(last.toMs, Math.min(endMs, voiceEnd));
  }
  const starts: number[] = new Array<number>(tokens.length).fill(0);
  let floor = -Infinity;
  for (const g of groups) {
    const midWord = stretches.some((s) => s.startMs < g.afterMs && s.endMs > g.afterMs);
    const fromMs = Math.max(g.fromMs, g.afterMs - (midWord ? PASS_SLACK_MS : 0), floor + MIN_WORD_MS);
    const toMs = Math.max(fromMs, g.toMs);
    const ws = tokens.slice(g.first, g.last).map(weight);
    const total = ws.reduce((a, b) => a + b, 0) || 1;
    const voiced = clip(stretches, fromMs, toMs);
    const voicedMs = voiced.reduce((n, s) => n + s.endMs - s.startMs, 0);
    let before = 0;
    ws.forEach((w, k) => {
      const share = before / total;
      let at = voicedMs >= 50 ? atVoiced(voiced, share * voicedMs) : fromMs + share * (toMs - fromMs);
      // The first word in a stretch of voice starts with it.
      const onset = stretches.find((s) => s.startMs >= fromMs && s.startMs > floor && at >= s.startMs && at - s.startMs <= SNAP_MS);
      if (onset) at = onset.startMs;
      at = Math.max(at, floor);
      starts[g.first + k] = Math.round(at);
      floor = at;
      before += w;
    });
  }
  return starts;
}

/**
 * One start per spoken piece of the line, as the run-through tokenizes it (`lineTokens`: each
 * printed word the character says, [bracketed] directions and {notes} left out), from the starts
 * of the live tracker's tokens. A piece with no tokens of its own (a dash) sits halfway between
 * its neighbours.
 */
export function pieceStarts(text: string, starts: readonly number[]): number[] {
  // Character offsets of the tracker's word pieces.
  const words: { from: number; to: number; token: number }[] = [];
  let at = 0;
  for (const p of segmentLine(text).pieces) {
    if (p.kind === "word" && p.tokenEnd > p.tokenStart) words.push({ from: at, to: at + p.text.length, token: p.tokenStart });
    at += p.text.length;
  }
  const spoken = lineTokens(text).flatMap((t) => (t.narrator ? [] : t.pieces.map(() => t)));
  const out: (number | null)[] = spoken.map((t) => {
    const w = words.find((x) => x.to > t.start && x.from < t.end);
    return w && w.token < starts.length ? starts[w.token]! : null;
  });
  for (let i = 0; i < out.length; i++) {
    if (out[i] !== null) continue;
    let prev = i - 1;
    while (prev >= 0 && out[prev] === null) prev--;
    let next = i + 1;
    while (next < out.length && out[next] === null) next++;
    const a = prev >= 0 ? out[prev]! : null;
    const b = next < out.length ? out[next]! : null;
    out[i] = a !== null && b !== null ? Math.round((a + b) / 2) : (a ?? b ?? 0);
  }
  // Never earlier than the piece before.
  let floor = 0;
  return out.map((v) => (floor = Math.max(floor, v!)));
}

/** How many starts a line needs: one per spoken piece (see `pieceStarts`). */
export function spokenPieceCount(text: string): number {
  return lineTokens(text).reduce((n, t) => n + (t.narrator ? 0 : t.pieces.length), 0);
}

/** Everything the live take keeps for timing its words, in ms of the take. */
export interface TakeTiming {
  lineId: string;
  text: string;
  /** Where the live capture's first sample sits in the recording. */
  offsetMs: number;
  clock: WordClock;
  stretches: Stretch[];
}

/** The word starts to send with a take, in ms of the recording, or null when none were heard. */
export function takeWordStarts(timing: TakeTiming | null, lineId: string, durationMs: number): number[] | null {
  if (!timing || timing.lineId !== lineId) return null;
  const { tokens } = segmentLine(timing.text);
  const starts = tokenStarts(timing.clock, timing.stretches, tokens, durationMs - timing.offsetMs);
  if (!starts) return null;
  const pieces = pieceStarts(timing.text, starts).map((ms) => Math.max(0, Math.min(Math.round(durationMs), ms + Math.round(timing.offsetMs))));
  return pieces.length === spokenPieceCount(timing.text) && pieces.length > 0 ? pieces : null;
}
