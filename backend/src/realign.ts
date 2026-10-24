import { linePieces } from "./taketiming.ts";
import type { Stretch } from "./render/trim.ts";

// Re-timing a take's words on the server, once the take is uploaded and normalized. The app sends
// when each word started from following the take live, but its speech model answers late and in
// windows, so a word heard by a later pass can land a pause too late (or the first word on the breath
// before it). The server has the whole recording at full quality and knows where the voice is
// (trim.ts: voiced, with the breaths and bumps cut). Every stretch of voice after a pause starts a
// word, and the line's words are known, so the words are laid on the voice in order: each stretch
// begins a word, and the words in a stretch share it by length. Of all the ways to do that, the one
// closest to the live starts wins. Measured on recorded fixture takes (19 lines, desktop speed and
// 3× and 5× slower): the first word's start moves from up to 240 ms off to 0, and the word after a
// beat from 668 ms off (p90) to 6 ms.

export const REALIGN = {
  pauseMs: 250, // a quiet gap this long between two stretches of voice is a pause: a word starts after it
  minStretchMs: 80, // voice shorter than this is a click or a breath's edge, not a word
  skipCost: 3000, // what leaving a stretch without a word costs, in ms of distance from the live starts (a cough, a laugh)
  farSkipCost: 300, // ...for a stretch a second or more outside the live words: likely not the line at all ("okay" after it)
  farMs: 1000,
  fitMs: 300, // a live start this close to the voice fits it
  minFit: 0.5, // fewer live starts than this share on the voice, and they don't say where the words are
  maxWords: 120, // longer speeches keep the live starts
  maxStretches: 60,
  maxPerStretch: 30, // words one stretch of voice may hold (without a pause): keeps the search to words × stretches × this²
  share: 0.9, // the words in a stretch start within its first 90%
} as const;

/** A piece's share of its stretch: its letters, and a little more (as the app weighs words). */
const weight = (text: string) => 1.5 + text.replace(/[^\p{L}\p{N}]/gu, "").length;

/** The voice as words can start on it: joined across gaps shorter than a pause, without slivers. */
export function voiceStretches(voice: readonly Stretch[]): Stretch[] {
  const out: Stretch[] = [];
  for (const s of voice) {
    const last = out[out.length - 1];
    if (last && s.startMs - last.endMs < REALIGN.pauseMs) last.endMs = Math.max(last.endMs, s.endMs);
    else out.push({ startMs: s.startMs, endMs: s.endMs });
  }
  return out.filter((s) => s.endMs - s.startMs >= REALIGN.minStretchMs);
}

/** Where each word of [from, to) starts when they share stretch `s` by weight. */
function place(weights: readonly number[], from: number, to: number, s: Stretch): number[] {
  let total = 0;
  for (let i = from; i < to; i++) total += weights[i]!;
  const out: number[] = [];
  let before = 0;
  for (let i = from; i < to; i++) {
    out.push(s.startMs + (before / total) * (s.endMs - s.startMs) * REALIGN.share);
    before += weights[i]!;
  }
  return out;
}

/**
 * The said words' starts laid on the voice (see above), in ms of the recording, or null when it
 * can't be done (no voice, no words, or too many to search).
 */
export function layOnVoice(live: readonly number[], weights: readonly number[], voice: readonly Stretch[]): number[] | null {
  const n = live.length;
  const m = voice.length;
  if (!n || !m || n > REALIGN.maxWords || m > REALIGN.maxStretches) return null;
  const cost = (from: number, to: number, s: Stretch) => place(weights, from, to, s).reduce((c, t, k) => c + Math.abs(t - live[from + k]!), 0);
  const lo = Math.min(...live) - REALIGN.farMs;
  const hi = Math.max(...live) + REALIGN.farMs;
  const skip = voice.map((s) => (s.endMs < lo || s.startMs > hi ? REALIGN.farSkipCost : REALIGN.skipCost));
  // best[k][j]: words [0, j) laid on stretches [0, k); how[k][j]: where stretch k's words begin (-1: it has none).
  const best = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(Infinity));
  const how = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(-1));
  best[0]![0] = 0;
  for (let k = 1; k <= m; k++) {
    for (let j = 0; j <= n; j++) {
      let b = best[k - 1]![j]! + skip[k - 1]!;
      let h = -1;
      for (let i = Math.max(0, j - REALIGN.maxPerStretch); i < j; i++) {
        if (best[k - 1]![i] === Infinity) continue;
        const c = best[k - 1]![i]! + cost(i, j, voice[k - 1]!);
        if (c < b) {
          b = c;
          h = i;
        }
      }
      best[k]![j] = b;
      how[k]![j] = h;
    }
  }
  if (best[m]![n] === Infinity) return null;
  const out = new Array<number>(n).fill(0);
  let j = n;
  for (let k = m; k >= 1; k--) {
    const i = how[k]![j]!;
    if (i < 0) continue;
    place(weights, i, j, voice[k - 1]!).forEach((t, q) => (out[i + q] = Math.round(t)));
    j = i;
  }
  return out;
}

/**
 * A take's word starts re-timed on its voice: one per piece of the line (`linePieces`), in ms of
 * the recording, like the app's. The narrator's pieces (a [direction]) take no time and start with
 * the next word said, or at the end of the voice. Null when the live starts don't fit the line or
 * the words can't be laid on the voice: then the live starts stay.
 */
export function realignWordStarts(live: readonly number[] | null, text: string, voice: readonly Stretch[]): number[] | null {
  const pieces = linePieces(text);
  if (!live || live.length !== pieces.length || !pieces.length) return null;
  const said = pieces.flatMap((p, i) => (p.narrator ? [] : [i]));
  const stretches = voiceStretches(voice);
  // Live starts that mostly miss the voice (the tracker piled the words into a late pass) say
  // nothing about where the words are: keep them, and let the cut go by loudness.
  const fits = said.filter((i) => stretches.some((s) => live[i]! >= s.startMs - REALIGN.fitMs && live[i]! <= s.endMs + REALIGN.fitMs)).length;
  if (fits < said.length * REALIGN.minFit) return null;
  const laid = layOnVoice(
    said.map((i) => live[i]!),
    said.map((i) => weight(pieces[i]!.text)),
    stretches,
  );
  if (!laid) return null;
  const out = new Array<number>(pieces.length).fill(0);
  said.forEach((i, k) => (out[i] = laid[k]!));
  // The narrator's pieces: with the next said piece, or at the end of the voice.
  let following = Math.round(stretches[stretches.length - 1]!.endMs);
  for (let i = pieces.length - 1; i >= 0; i--) {
    if (pieces[i]!.narrator) out[i] = following;
    else following = out[i]!;
  }
  // Never earlier than the piece before.
  let floor = 0;
  return out.map((t) => (floor = Math.max(floor, t)));
}
