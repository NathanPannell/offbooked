import type { FlagCode, Line } from "../../api/types";

// Moving through the lines the parser wasn't sure about, in script order, inside the full script.

/** Which flagged lines the navigator walks: all of them, one reason, or those with no reason ("other"). */
export type FlagFilter = "all" | FlagCode | "other";

/** What to check, as a line's chip says it. */
export const FLAG_LABELS: Record<FlagCode, string> = {
  speaker: "Confirm the speaker",
  missed_cue: "Check for a missed speaker",
  direction: "Review stage direction",
  text: "Check the text against the original",
  heading: "Check the scene heading",
  backup: "Check this passage",
};
export const FLAG_FALLBACK = "Check this line";

/** Short names for the counts in the review bar. */
export const FLAG_SHORT: Record<FlagCode | "other", string> = {
  speaker: "Speaker",
  missed_cue: "Missed speaker",
  direction: "Direction",
  text: "Text",
  heading: "Heading",
  backup: "Passage",
  other: "Other",
};

const ORDER: (FlagCode | "other")[] = ["speaker", "missed_cue", "direction", "text", "heading", "backup", "other"];

export const flagLabel = (line: Pick<Line, "flagCode">): string => (line.flagCode && FLAG_LABELS[line.flagCode]) || FLAG_FALLBACK;

/** The filter bucket a flagged line falls in. Unknown codes from a newer server count as "other". */
export const flagBucket = (line: Pick<Line, "flagCode">): FlagCode | "other" =>
  line.flagCode && line.flagCode in FLAG_LABELS ? line.flagCode : "other";

const matches = (line: Line, filter: FlagFilter) => filter === "all" || flagBucket(line) === filter;

/** How many flagged lines there are of each reason, in a fixed order, leaving out reasons with none. */
export function flagCounts(lines: Line[]): { code: FlagCode | "other"; count: number }[] {
  const counts = new Map<FlagCode | "other", number>();
  for (const l of lines) if (l.flagged) counts.set(flagBucket(l), (counts.get(flagBucket(l)) ?? 0) + 1);
  return ORDER.filter((c) => counts.has(c)).map((code) => ({ code, count: counts.get(code)! }));
}

export interface FlagPosition {
  /** 1-based position of the current line among flagged lines, or null when it isn't flagged. */
  index: number | null;
  total: number;
}

export function flaggedLines(lines: Line[], filter: FlagFilter = "all"): Line[] {
  return lines.filter((l) => l.flagged && matches(l, filter)).sort((a, b) => a.seq - b.seq);
}

export function flagPosition(lines: Line[], currentId: string | null, filter: FlagFilter = "all"): FlagPosition {
  const flagged = flaggedLines(lines, filter);
  const at = currentId ? flagged.findIndex((l) => l.id === currentId) : -1;
  return { index: at >= 0 ? at + 1 : null, total: flagged.length };
}

/**
 * The next (or previous) flagged line from a point in the script, wrapping around. `fromSeq` is the
 * seq of the line you're on, which may since have been resolved, split or merged away; null starts
 * from the top (or the bottom, going back). `filter` keeps to one reason.
 */
export function nextFlagged(lines: Line[], fromSeq: number | null, direction: 1 | -1 = 1, filter: FlagFilter = "all"): Line | null {
  const flagged = flaggedLines(lines, filter);
  if (flagged.length === 0) return null;
  if (fromSeq === null) return direction === 1 ? flagged[0]! : flagged[flagged.length - 1]!;
  if (direction === 1) return flagged.find((l) => l.seq > fromSeq) ?? flagged[0]!;
  return [...flagged].reverse().find((l) => l.seq < fromSeq) ?? flagged[flagged.length - 1]!;
}
