import type { CuePlan } from "./cuePlan";
import type { QueueLine } from "./queue";

// The slim rows that stand in for the stretches a plan leaves out (cuePlan.ts), so the script glides
// from one of the listener's lines to the next. Tapping one opens it.

/** The most names a row spells out. */
export const ROW_NAMES = 3;

export interface SkippedRow {
  /** The first line left out: keys the row and places it. */
  lineId: string;
  /** The stretch, as line indexes [from, to). */
  from: number;
  to: number;
  label: string;
}

/** "14 lines · Escalus, Angelo", with the speakers in order of first line and the rest as "+2". */
export function rowLabel(lines: number, speakers: string[]): string {
  const count = `${lines} ${lines === 1 ? "line" : "lines"}`;
  if (!speakers.length) return count;
  const shown = speakers.slice(0, ROW_NAMES).join(", ");
  const rest = speakers.length - ROW_NAMES;
  return `${count} · ${shown}${rest > 0 ? ` +${rest}` : ""}`;
}

/** The plan's stretches as rows. `speakerOf` names a line's speaker, or "" for a stage direction. */
export function skippedRows(queue: readonly QueueLine[], plan: CuePlan | null | undefined, speakerOf: (lineId: string) => string): SkippedRow[] {
  return (plan?.skipped ?? []).map(({ from, to }) => {
    const names = queue.slice(from, to).map((line) => speakerOf(line.lineId));
    return { lineId: queue[from]!.lineId, from, to, label: rowLabel(to - from, [...new Set(names.filter(Boolean))]) };
  });
}
