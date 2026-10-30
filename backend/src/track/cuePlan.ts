// What a listener with a part hears, worked out the same way by the player and by the server that
// builds their listen track ahead of time. This file is the same, byte for byte, in web/src/player
// and backend/src/track (backend/src/track/cuePlan.test.ts fails when they differ): a plan that
// differs by one line is another track, and the first play falls back to line by line.
//
// The only inputs are the script (order, scenes, kinds, text) and the listener's lines. A take's
// length is deliberately not one: a new take would change the plan under a track already built,
// and the player and the server would have to see the same take at the same moment. Time is the
// words at a stage pace, measured at 1×, so a change of speed never changes the plan either.

/** More than this many lines between two of the listener's lines is skipped; the cue still plays. */
export const SKIP_OVER_LINES = 3;
/** So is a stretch whose words take longer than this at a stage pace at 1×. */
export const SKIP_OVER_MS = 60_000;
/** A stage pace (about 150 words a minute), and the shortest a line counts for. */
const WORDS_PER_SECOND = 2.5;
const MIN_LINE_MS = 1000;

/** The most lines one listen track covers. */
export const TRACK_LINES = 300;
/** The player asks for the next stretch this many lines before the end of the one playing. */
export const REFRESH_LINES = 40;
/** Stretches start every this many played lines, so each overlaps the next by REFRESH_LINES. */
export const TRACK_STRIDE = TRACK_LINES - REFRESH_LINES;

export interface PlanLine {
  lineId: string;
  sectionId: string;
  text: string;
  /** Stage directions are never a cue. */
  kind?: string;
}

export interface CuePlan {
  /** Where each of the listener's lines is cued from, in order: where ⏮ and ⏭ land. */
  cues: number[];
  /** A line and where the play goes after it, past lines left out. `lines.length` ends the play. */
  jumps: Map<number, number>;
  /** The stretches left out, as line indexes [from, to). */
  skipped: { from: number; to: number }[];
  /** The lines that play, in order. A line in a stretch left out still plays if the listener goes there. */
  played: number[];
}

/** How long a line's words take at 1×. */
function estimateMs(text: string): number {
  const said = text
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\[[^\n]*/g, " ")
    .replace(/\{[^}]*\}/g, " ");
  const words = said.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
  return Math.max(MIN_LINE_MS, Math.round((words / WORDS_PER_SECOND) * 1000));
}

/** Whether the lines [from, to) are too long to sit through. */
function tooLong(lines: readonly PlanLine[], from: number, to: number): boolean {
  if (to - from > SKIP_OVER_LINES) return true;
  let ms = 0;
  for (let i = from; i < to; i++) ms += estimateMs(lines[i]!.text);
  return ms > SKIP_OVER_MS;
}

/** The cue of the listener's line at `at`: the dialogue line before it, in its scene and not theirs. Else the line itself. */
function cueOf(lines: readonly PlanLine[], at: number, mine: ReadonlySet<string>): number {
  for (let i = at - 1; i >= 0 && lines[i]!.sectionId === lines[at]!.sectionId; i--) {
    if (lines[i]!.kind === "stage_direction") continue;
    return mine.has(lines[i]!.lineId) ? at : i;
  }
  return at;
}

/**
 * The plan for these lines (in playback order) and the listener's lines, or null when they have
 * none in it. A stretch before their first line, between two of theirs or after their last that is
 * too long is left out: the play starts at the cue, goes from their line to the next cue, or ends
 * after their last line. `skip` false plays everything and keeps the cues for ⏮ and ⏭.
 */
export function planCues(lines: readonly PlanLine[], mine: ReadonlySet<string>, skip = true): CuePlan | null {
  const own: number[] = [];
  lines.forEach((line, i) => {
    if (mine.has(line.lineId)) own.push(i);
  });
  if (!own.length) return null;
  const cues = own.map((at) => cueOf(lines, at, mine));
  const jumps = new Map<number, number>();
  const skipped: CuePlan["skipped"] = [];
  if (skip) {
    if (tooLong(lines, 0, own[0]!) && cues[0]! > 0) skipped.push({ from: 0, to: cues[0]! });
    own.forEach((at, k) => {
      const next = own[k + 1];
      const to = next === undefined ? lines.length : cues[k + 1]!;
      if (to > at + 1 && tooLong(lines, at + 1, next ?? lines.length)) {
        jumps.set(at, to);
        skipped.push({ from: at + 1, to });
      }
    });
  }
  const played: number[] = [];
  let leaving = 0;
  for (let i = 0; i < lines.length; i++) {
    while (skipped[leaving] && i >= skipped[leaving]!.to) leaving++;
    if (!skipped[leaving] || i < skipped[leaving]!.from) played.push(i);
  }
  return { cues, jumps, skipped, played };
}

/** Where the stretch for the `position`th played line starts, of `count` played lines. */
export function trackStart(position: number, count: number): number {
  const last = Math.max(0, Math.ceil((count - TRACK_LINES) / TRACK_STRIDE)) * TRACK_STRIDE;
  return Math.min(Math.floor(Math.max(0, position) / TRACK_STRIDE) * TRACK_STRIDE, last);
}

/** How many lines play. */
export const playedCount = (lines: readonly PlanLine[], plan: CuePlan | null): number => plan?.played.length ?? lines.length;

/** Where line `index` falls among the lines that play: its place, or that of the next one that plays. */
export function positionOf(plan: CuePlan | null, index: number): number {
  const i = Math.max(0, index);
  if (!plan) return i;
  let lo = 0;
  let hi = plan.played.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (plan.played[mid]! < i) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** A listen track's lines, and the ones among them a skip follows (the fast-forward sound plays before the next listed line). */
export interface Stretch {
  lineIds: string[];
  skips: string[];
}

/** Up to `max` played lines from the `start`th: one listen track. */
export function stretchFrom(lines: readonly PlanLine[], plan: CuePlan | null, start: number, max = TRACK_LINES): Stretch {
  const count = playedCount(lines, plan);
  const end = Math.min(start + max, count);
  const lineIds: string[] = [];
  const skips: string[] = [];
  for (let at = start; at < end; at++) {
    const index = plan ? plan.played[at]! : at;
    lineIds.push(lines[index]!.lineId);
    if (at + 1 < end && plan?.jumps.has(index)) skips.push(lines[index]!.lineId);
  }
  return { lineIds, skips };
}

/** Every stretch a listener can ask for, in order: what is built ahead. */
export function planStretches(lines: readonly PlanLine[], plan: CuePlan | null): (Stretch & { start: number })[] {
  const count = playedCount(lines, plan);
  const out: (Stretch & { start: number })[] = [];
  for (let start = 0; start < count; start += TRACK_STRIDE) {
    out.push({ start, ...stretchFrom(lines, plan, start) });
    if (start + TRACK_LINES >= count) break;
  }
  return out;
}
