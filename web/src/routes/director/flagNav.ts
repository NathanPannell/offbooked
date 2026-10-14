import type { Line } from "../../api/types";

// Moving through the lines the parser wasn't sure about, in script order, inside the full script.

export interface FlagPosition {
  /** 1-based position of the current line among flagged lines, or null when it isn't flagged. */
  index: number | null;
  total: number;
}

export function flaggedLines(lines: Line[]): Line[] {
  return lines.filter((l) => l.flagged).sort((a, b) => a.seq - b.seq);
}

export function flagPosition(lines: Line[], currentId: string | null): FlagPosition {
  const flagged = flaggedLines(lines);
  const at = currentId ? flagged.findIndex((l) => l.id === currentId) : -1;
  return { index: at >= 0 ? at + 1 : null, total: flagged.length };
}

/**
 * The next (or previous) flagged line from a point in the script, wrapping around. `fromSeq` is the
 * seq of the line you're on, which may since have been resolved, split or merged away; null starts
 * from the top (or the bottom, going back).
 */
export function nextFlagged(lines: Line[], fromSeq: number | null, direction: 1 | -1 = 1): Line | null {
  const flagged = flaggedLines(lines);
  if (flagged.length === 0) return null;
  if (fromSeq === null) return direction === 1 ? flagged[0]! : flagged[flagged.length - 1]!;
  if (direction === 1) return flagged.find((l) => l.seq > fromSeq) ?? flagged[0]!;
  return [...flagged].reverse().find((l) => l.seq < fromSeq) ?? flagged[flagged.length - 1]!;
}
