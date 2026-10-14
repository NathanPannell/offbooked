import type { Line } from "../../api/types";

// Where a script line sits in the original document, for the source pane beside the review.

export interface SourceRange {
  start: number;
  end: number;
}

const MAX_SPAN = 60;

/**
 * The source lines a script line came from: from its `sourceLine` up to just before the next line
 * that starts further down. Lines cut from one passage (a speech and its stage direction) share a
 * start. Null when the parse recorded no position. `lines` must be in seq order.
 */
export function sourceRange(lines: Line[], line: Line): SourceRange | null {
  const start = line.sourceLine;
  if (!start) return null;
  let next: number | null = null;
  const from = lines.indexOf(line);
  for (let i = from >= 0 ? from + 1 : 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (l.seq > line.seq && l.sourceLine && l.sourceLine > start) {
      next = l.sourceLine;
      break;
    }
  }
  const textLines = line.text.split("\n").length;
  const end = next !== null ? next - 1 : start + textLines + 1;
  return { start, end: Math.max(start, Math.min(end, start + MAX_SPAN)) };
}

/** The PDF page to show for a line: its own page, or the page its source line is on. */
export function pageForLine(line: Line, sourcePages?: Map<number, number | null>): number | null {
  if (line.page) return line.page;
  if (line.sourceLine && sourcePages) return sourcePages.get(line.sourceLine) ?? null;
  return null;
}

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/**
 * Which of a PDF page's text items make up `target`, for highlighting it on the page. Matches on
 * letters and digits only, so hyphens, kerning splits and line breaks don't matter. Falls back to
 * the start or the end of the line when the whole of it isn't on this page (a speech across a page
 * break). Returns item indexes, empty when nothing matches.
 */
export function matchTextItems(items: string[], target: string): number[] {
  const wanted = norm(target);
  if (wanted.length < 3) return [];
  const owner: number[] = [];
  let haystack = "";
  items.forEach((item, i) => {
    const n = norm(item);
    haystack += n;
    for (let k = 0; k < n.length; k++) owner.push(i);
  });
  if (!haystack) return [];

  const cover = (from: number, to: number) => {
    const hit = new Set<number>();
    for (let k = Math.max(0, from); k < Math.min(haystack.length, to); k++) hit.add(owner[k]!);
    return [...hit].sort((a, b) => a - b);
  };

  const whole = haystack.indexOf(wanted);
  if (whole >= 0) return cover(whole, whole + wanted.length);
  if (wanted.length > 24) {
    // The start is here and the rest runs onto the next page, or the end is here and it began on the last.
    const head = haystack.indexOf(wanted.slice(0, 24));
    if (head >= 0) return cover(head, head + wanted.length);
    const tailNeedle = wanted.slice(-24);
    const tail = haystack.indexOf(tailNeedle);
    if (tail >= 0) return cover(tail + tailNeedle.length - wanted.length, tail + tailNeedle.length);
  }
  return [];
}

/**
 * Where a line's text ends in the source, walking from `start` until the letters seen cover the
 * line's own letters. Keeps the highlight honest when the next line's position is unknown.
 */
export function coverEnd(source: { n: number; text: string }[], start: number, text: string, maxEnd: number): number {
  const wanted = norm(text).length;
  if (!wanted) return start;
  let seen = 0;
  for (const l of source) {
    if (l.n < start) continue;
    if (l.n > maxEnd) break;
    seen += norm(l.text).length;
    if (seen >= wanted) return l.n;
  }
  return maxEnd;
}
