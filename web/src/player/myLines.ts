import type { QueueLine } from "./queue";

// "My previous line" and "My next line" in the run-through, for a listener following one part: a
// tap goes from one of their lines to the next, past runs of other people's lines and past scenes
// they're not in. Each jump lands on the line's cue (the line before it, in its scene and not their
// own), so playing on from there they still hear what they answer.

/** One of the listener's lines, as queue indexes: the line itself, and where a jump to it lands. */
export interface MyStop {
  line: number;
  /** Its cue when it has one, else the line itself. */
  land: number;
}

/**
 * The listener's lines in play order. A cue is the dialogue line before (stage directions between
 * are passed over, as for the underlined cue) when it is in the same scene and not theirs.
 */
export function myStops(queue: readonly QueueLine[], mine: ReadonlySet<string>): MyStop[] {
  const stops: MyStop[] = [];
  let before = -1;
  queue.forEach((q, i) => {
    if (q.kind === "stage_direction") return;
    if (mine.has(q.lineId)) {
      const cue = queue[before];
      const hasCue = cue !== undefined && cue.sectionId === q.sectionId && !mine.has(cue.lineId);
      stops.push({ line: i, land: hasCue ? before : i });
    }
    before = i;
  });
  return stops;
}

/** The stop `index` sits in (on its cue, on the line, or between them), if any. */
function stopAt(stops: readonly MyStop[], index: number): number {
  return stops.findIndex((s) => s.land <= index && index <= s.line);
}

/** Where "My next line" goes from `index` (-1: nothing played yet), or null after the last one. */
export function nextMine(stops: readonly MyStop[], index: number): number | null {
  return stops.find((s) => s.land > index)?.land ?? null;
}

/**
 * Where "My previous line" goes from `index`: the line before the one being cued or said, else the
 * last one before `index`. Null when there is none.
 */
export function previousMine(stops: readonly MyStop[], index: number): number | null {
  const at = stopAt(stops, index);
  if (at >= 0) return stops[at - 1]?.land ?? null;
  for (let i = stops.length - 1; i >= 0; i--) if (stops[i]!.line < index) return stops[i]!.land;
  return null;
}

/** Which of the listener's lines `index` has reached, counting from 1 (0: none yet). Its cue counts. */
export function myLineNumber(stops: readonly MyStop[], index: number): number {
  let n = 0;
  for (const s of stops) if (s.land <= index) n++;
  return n;
}
