import { gapMs, wordCount } from "./timing";

// Pure planning for line-by-line playback: which line plays next, how long the pause before it
// is, what the listener says themselves in my-part mode, and which clips to fetch ahead. The
// numbers match the server's stitched render (RENDER_SETTINGS in backend/src/render/plan.ts).

export const LINE_GAP_MS = 350;
export const SECTION_GAP_MS = 1200;
const MS_PER_WORD = 380;

export interface QueueLine {
  lineId: string;
  sectionId: string;
  text: string;
}

export interface Ab {
  a: number | null;
  b: number | null;
}

/** The A–B range as first and last index, or null until both ends are set. */
export function abBounds(ab: Ab): { first: number; last: number } | null {
  if (ab.a === null || ab.b === null) return null;
  return { first: Math.min(ab.a, ab.b), last: Math.max(ab.a, ab.b) };
}

/** The line after `index`: the next one, or the start of the A–B range at its end. Null at the end of the play. */
export function nextIndex(lines: QueueLine[], index: number, ab: Ab): number | null {
  const range = abBounds(ab);
  if (range && index === range.last) return range.first;
  return index + 1 < lines.length ? index + 1 : null;
}

/** The pause between two lines: short within a scene, longer at a scene change or an A–B jump back. */
export function gapBetweenMs(lines: QueueLine[], from: number, to: number): number {
  const a = lines[from];
  const b = lines[to];
  if (!a || !b) return 0;
  return to === from + 1 && a.sectionId === b.sectionId ? LINE_GAP_MS : SECTION_GAP_MS;
}

/** Restarts the current line once it has played a while, otherwise goes back one. */
export function previousIndex(index: number, elapsedMs: number, restartAfterMs = 1500): number {
  if (index < 0) return 0;
  return elapsedMs > restartAfterMs ? index : Math.max(0, index - 1);
}

/** What happens at a line: its audio, or in my-part mode a pause while the actor says it. */
export type Step = { kind: "line"; index: number } | { kind: "speak"; index: number; durationMs: number };

export function stepFor(lines: QueueLine[], index: number, mine: Set<string> | null, multiplier: number): Step {
  const line = lines[index];
  if (line && mine?.has(line.lineId)) return { kind: "speak", index, durationMs: gapMs(line.text, multiplier) };
  return { kind: "line", index };
}

/**
 * The line IDs to have ready, in playback order from `index` (included): following A–B loops,
 * skipping the listener's own lines in my-part mode (they play no audio), each at most once.
 */
export function prefetchWindow(lines: QueueLine[], index: number, count: number, mine: Set<string> | null, ab: Ab): string[] {
  const out: string[] = [];
  const seen = new Set<number>();
  for (let i: number | null = Math.max(0, index); i !== null && out.length < count && !seen.has(i); i = nextIndex(lines, i, ab)) {
    seen.add(i);
    const line = lines[i];
    if (!line) break;
    if (!mine?.has(line.lineId)) out.push(line.lineId);
  }
  return out;
}

/** How long a line with no audio stays silent, as in the render. */
export function placeholderMs(text: string): number {
  return Math.min(8000, Math.max(1200, wordCount(text) * MS_PER_WORD));
}
