import { myLinePauseMs, wordCount } from "./timing";

// Pure planning for line-by-line playback: which line plays next, how long the pause before it
// is, what happens on the listener's own lines, and which clips to fetch ahead. The gaps match the
// server's stitched render (RENDER_SETTINGS in backend/src/render/plan.ts).

export const LINE_GAP_MS = 350;
export const SECTION_GAP_MS = 1200;
const MS_PER_WORD = 380;

export interface QueueLine {
  lineId: string;
  sectionId: string;
  text: string;
  /** Stage directions are read by the narrator; they never belong to the listener. */
  kind?: "dialogue" | "stage_direction";
}

/**
 * What happens on the listener's own lines: played like everyone else's ("read"), a silence as
 * long as the line takes to say and then on to the next ("skip": the voice is left out, the time
 * isn't), or that silence and then the line itself ("pause").
 */
export type MyLineMode = "read" | "skip" | "pause";

/** The listener's lines (null: no role picked) and what to do with them. */
export interface Part {
  mine: Set<string> | null;
  mode: MyLineMode;
}

export const NO_PART: Part = { mine: null, mode: "read" };

export const isMine = (part: Part, line: QueueLine | undefined): boolean => Boolean(line && part.mine?.has(line.lineId));

/** The same lines and the same mode on them: what one plays, the other plays too. */
export function samePart(a: Part, b: Part): boolean {
  if ((a.mine?.size ?? 0) !== (b.mine?.size ?? 0)) return false;
  if (a.mine?.size && a.mode !== b.mode) return false;
  for (const id of a.mine ?? []) if (!b.mine?.has(id)) return false;
  return true;
}

/** The same lines in the same order (a reloaded script that didn't change). */
export function sameLines(a: QueueLine[], b: QueueLine[]): boolean {
  return a === b || (a.length === b.length && a.every((l, i) => l.lineId === b[i]!.lineId && l.sectionId === b[i]!.sectionId));
}

/** The first line at or after `index`, or null when none is left. Every line takes its time. */
export function playableFrom(lines: QueueLine[], index: number, _part: Part = NO_PART): number | null {
  const i = Math.max(0, index);
  return i < lines.length ? i : null;
}

/** The line after `index`. Null at the end of the play. */
export function nextIndex(lines: QueueLine[], index: number, part: Part = NO_PART): number | null {
  return playableFrom(lines, index + 1, part);
}

/** The pause between two lines: short within a scene, longer at a scene change. */
export function gapBetweenMs(lines: QueueLine[], from: number, to: number): number {
  const a = lines[from];
  const b = lines[to];
  if (!a || !b) return 0;
  return a.sectionId === b.sectionId ? LINE_GAP_MS : SECTION_GAP_MS;
}

/** Restarts the current line once it has played a while, otherwise goes back one. */
export function previousIndex(index: number, elapsedMs: number, restartAfterMs = 1500): number {
  if (index < 0) return 0;
  return elapsedMs > restartAfterMs ? index : Math.max(0, index - 1);
}

/**
 * What happens at a line: its audio (at the listener's chosen speed for other people's lines, at
 * normal speed for their own), or a silence while the listener says it, followed by the line
 * ("pause") or by the next line ("skip"). `recordedMs` is the line's take length when it has one,
 * which times the silence.
 */
export type Step = { kind: "line"; index: number; mine: boolean } | { kind: "speak"; index: number; durationMs: number; then: "read" | "next" };

export function stepFor(lines: QueueLine[], index: number, part: Part, recordedMs?: number | null): Step {
  const line = lines[index];
  const mine = isMine(part, line);
  if (line && mine && part.mode !== "read") {
    return { kind: "speak", index, durationMs: myLinePauseMs({ text: line.text, recordedMs }), then: part.mode === "pause" ? "read" : "next" };
  }
  return { kind: "line", index, mine };
}

/** The line IDs to have ready, in playback order from `index` (included). My lines in "skip" are
 * fetched too: a recorded take times their silence. */
export function prefetchWindow(lines: QueueLine[], index: number, count: number, part: Part = NO_PART): string[] {
  const out: string[] = [];
  for (let i = playableFrom(lines, index, part); i !== null && out.length < count; i = nextIndex(lines, i, part)) {
    out.push(lines[i]!.lineId);
  }
  return out;
}

/** How long a line with no audio stays silent, as in the render. */
export function placeholderMs(text: string): number {
  return Math.min(8000, Math.max(1200, wordCount(text) * MS_PER_WORD));
}
