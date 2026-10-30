import type { MyStop } from "./myLines";
import { gapBetweenMs, type QueueLine } from "./queue";
import { STAGE_WORDS_PER_SECOND, wordCount } from "./timing";

// "Skip to my cues": with it on, after each of the listener's lines the player looks at the stretch
// before their next one. A short one plays through. A longer one is left out: a short fast-forward
// sound, then the cue line just before their next line. A very long one (or one with a whole scene
// they're not in) stops the play and asks whether to jump. Pure planning; the engine follows it.

/** More than this many lines between two of mine is skipped (the cue still plays). */
export const SKIP_OVER_LINES = 3;
/** So is a stretch that takes more than this long to listen to. */
export const SKIP_OVER_MS = 60_000;
/** A stretch longer than this stops the play and asks first, as does one with a whole scene in it. */
export const STOP_OVER_MS = 20 * 60_000;

export type GapKind = "play" | "skip" | "stop";

/** The stretch between two of the listener's lines. */
export interface GapSize {
  /** Lines (dialogue and directions) between them. */
  lines: number;
  /** How long it takes to listen to, at the playback speed, pauses included. */
  ms: number;
  /** Whole scenes in it: scenes the listener has no line in. */
  scenes: number;
}

/** What happens after one of the listener's lines, as queue indexes. */
export interface Jump {
  kind: "skip" | "stop";
  /** The listener's line it follows. */
  from: number;
  /** Where it lands: the cue of their next line, else that line. */
  to: number;
  /** Their next line. */
  next: number;
  /** The stretch it leaves out, as measured. */
  gap: GapSize;
}

/** A line's length before its audio is known: its words at a stage pace (about 150 a minute). */
export function estimateMs(text: string): number {
  return Math.max(1000, Math.round((wordCount(text) / STAGE_WORDS_PER_SECOND) * 1000));
}

/** Small plays through; past SKIP_OVER_LINES lines or SKIP_OVER_MS it skips; past STOP_OVER_MS, or with a whole scene in it, it stops. */
export function classifyGap(gap: GapSize): GapKind {
  if (gap.lines <= SKIP_OVER_LINES && gap.ms <= SKIP_OVER_MS) return "play";
  if (gap.ms > STOP_OVER_MS || gap.scenes > 0) return "stop";
  return "skip";
}

/**
 * The stretch between the listener's line at `from` and their next at `next`. Other people's lines
 * play at `speed`; the pauses between lines don't change with it. `durationOf` is a line's clip
 * length when known.
 */
export function measureGap(
  queue: readonly QueueLine[],
  from: number,
  next: number,
  durationOf: (lineId: string) => number | undefined,
  speed: number,
): GapSize {
  let ms = 0;
  for (let i = from + 1; i < next; i++) {
    const line = queue[i]!;
    ms += (durationOf(line.lineId) ?? estimateMs(line.text)) / speed;
  }
  for (let i = from; i < next; i++) ms += gapBetweenMs(queue as QueueLine[], i, i + 1);
  // Scenes run in one stretch each, so any scene between the two lines' own scenes is whole.
  const scenes = new Set<string>();
  for (let i = from + 1; i < next; i++) scenes.add(queue[i]!.sectionId);
  scenes.delete(queue[from]!.sectionId);
  scenes.delete(queue[next]!.sectionId);
  return { lines: Math.max(0, next - from - 1), ms: Math.round(ms), scenes: scenes.size };
}

/** The skips and stops after each of the listener's lines (`stops`, from myLines.ts), keyed by that line's index. */
export function planJumps(
  queue: readonly QueueLine[],
  stops: readonly MyStop[],
  durationOf: (lineId: string) => number | undefined,
  speed: number,
): Map<number, Jump> {
  const jumps = new Map<number, Jump>();
  for (let k = 0; k + 1 < stops.length; k++) {
    const from = stops[k]!.line;
    const { line: next, land: to } = stops[k + 1]!;
    const gap = measureGap(queue, from, next, durationOf, speed);
    const kind = classifyGap(gap);
    if (kind !== "play") jumps.set(from, { kind, from, to, next, gap });
  }
  return jumps;
}

/** The same skips and stops: an unchanged plan needn't rebuild a listen track. */
export function sameJumps(a: ReadonlyMap<number, Jump> | undefined, b: ReadonlyMap<number, Jump> | undefined): boolean {
  if ((a?.size ?? 0) !== (b?.size ?? 0)) return false;
  for (const [from, jump] of a ?? []) {
    const other = b?.get(from);
    if (!other || other.kind !== jump.kind || other.to !== jump.to) return false;
  }
  return true;
}

/** How far ahead a stop's next line is, for its prompt: "less than a minute", "about 1 min", "about 25 min". */
export function aheadText(ms: number): string {
  if (ms < 60_000) return "less than a minute";
  return `about ${Math.round(ms / 60_000)} min`;
}
