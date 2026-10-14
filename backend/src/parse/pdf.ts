import { extractTextItems } from "unpdf";

// A problem with the director's input; the message is shown to them as is.
export class ScriptInputError extends Error {}

export const MAX_PDF_PAGES = 300;
export const PAGE_BREAK = "\f";

interface Item {
  str: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fontSize: number;
}

interface PageLine {
  text: string;
  y: number;
  height: number;
}

export async function extractPdfText(data: Uint8Array): Promise<{ text: string; pages: number }> {
  let result: Awaited<ReturnType<typeof extractTextItems>>;
  try {
    result = await extractTextItems(data);
  } catch {
    throw new ScriptInputError("We couldn't read this PDF. Try exporting it again, or paste the script text instead.");
  }
  if (result.totalPages > MAX_PDF_PAGES) throw new ScriptInputError(`This PDF has ${result.totalPages} pages. The limit is ${MAX_PDF_PAGES}.`);

  const pages = result.items.map((items) => pageLines(dropOverprints(items.filter((i) => i.str.trim() && i.dir !== "ttb"))));
  const visibleChars = pages.flat().reduce((n, l) => n + l.text.replace(/\s/g, "").length, 0);
  if (visibleChars < Math.max(50, result.totalPages * 25)) {
    throw new ScriptInputError("This PDF looks like scanned images, so there is no text to read. Paste the script text instead.");
  }
  const text = dropRunningHeaders(pages)
    .map((lines) => withParagraphBreaks(lines))
    // A form feed on its own line marks each page break, so parsed lines can point back to their page.
    .join(`\n${PAGE_BREAK}\n`)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { text, pages: result.totalPages };
}

// Some PDFs fake bold type by drawing the same text several times a fraction of a point apart.
// An item that sits inside another item's box and whose text that item already contains is a
// duplicate print, not more words.
export function dropOverprints<T extends Item>(items: T[]): T[] {
  const tol = 1.5;
  const sorted = [...items].sort((a, b) => b.str.length - a.str.length);
  const kept: T[] = [];
  for (const it of sorted) {
    const dup = kept.some(
      (k) =>
        Math.abs(k.y - it.y) <= tol &&
        it.x >= k.x - tol &&
        it.x + it.width <= k.x + k.width + tol &&
        k.str.includes(it.str.trim()),
    );
    if (!dup) kept.push(it);
  }
  return items.filter((it) => kept.includes(it));
}

// Groups items into visual lines (top to bottom, left to right). A page is only read as two
// columns when both halves hold real text; a name gutter beside dialogue stays one line.
function pageLines(items: Item[]): PageLine[] {
  const rows = groupRows(items);
  const split = columnSplit(rows);
  if (split === null) return withIndent(rows);
  const left = groupRows(items.filter((i) => i.x < split));
  const right = groupRows(items.filter((i) => i.x >= split));
  return [...withIndent(left), ...withIndent(right)];
}

// Lines keep their indentation as printed, measured from the column's left margin in
// character widths (approximate: PDFs don't store spaces for indentation).
function withIndent(rows: Item[][]): PageLine[] {
  if (!rows.length) return [];
  const margin = Math.min(...rows.map((r) => r[0]!.x));
  return rows.map((row) => {
    const line = toLine(row);
    const charWidth = (row[0]!.fontSize || 10) * 0.5;
    const indent = Math.min(40, Math.max(0, Math.round((row[0]!.x - margin) / charWidth)));
    return { ...line, text: " ".repeat(indent) + line.text };
  });
}

function groupRows(items: Item[]): Item[][] {
  const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x);
  const rows: Item[][] = [];
  for (const item of sorted) {
    const row = rows[rows.length - 1];
    const tolerance = Math.max(2, (item.height || item.fontSize || 10) * 0.5);
    if (row && Math.abs(row[0]!.y - item.y) <= tolerance) row.push(item);
    else rows.push([item]);
  }
  return rows.map((r) => r.sort((a, b) => a.x - b.x));
}

function toLine(row: Item[]): PageLine {
  let text = "";
  let end = -Infinity;
  for (const item of row) {
    const gap = item.x - end;
    let str = item.str;
    // An item that starts inside the previous one and repeats its last letters is a kerning
    // split ("MARLO" + "OW" + "W. Yes"); keep only the new letters.
    if (text && gap < -(item.fontSize || 10) * 0.2) {
      for (let k = Math.min(str.length, 6); k > 0; k--) {
        if (text.endsWith(str.slice(0, k))) {
          str = str.slice(k);
          break;
        }
      }
    }
    if (text && gap > (item.fontSize || 10) * 0.15 && !/\s$/.test(text) && !/^\s/.test(str)) text += " ";
    text += str;
    end = Math.max(end, item.x + item.width);
  }
  return { text: text.replace(/\s+/g, " ").trim(), y: row[0]!.y, height: Math.max(...row.map((i) => i.height || i.fontSize || 10)) };
}

function columnSplit(rows: Item[][]): number | null {
  if (rows.length < 10) return null;
  const mids: number[] = [];
  for (const row of rows) {
    for (let i = 1; i < row.length; i++) {
      const prev = row[i - 1]!;
      const gapStart = prev.x + prev.width;
      const before = row.slice(0, i).reduce((n, it) => n + it.str.length, 0);
      const after = row.slice(i).reduce((n, it) => n + it.str.length, 0);
      if (row[i]!.x - gapStart > 24 && before > 20 && after > 20) mids.push((gapStart + row[i]!.x) / 2);
    }
  }
  if (mids.length < rows.length * 0.5) return null;
  mids.sort((a, b) => a - b);
  return mids[Math.floor(mids.length / 2)]!;
}

const PAGE_NUMBER_RE = /^(?:page\s*)?[\divxlc]{1,6}(?:\s*(?:of|\/)\s*\d{1,4})?\.?$/i;
const headerKey = (s: string) => s.toLowerCase().replace(/\d+/g, "#").replace(/\s+/g, " ").trim();

// Removes page numbers and text that repeats at the top or bottom of many pages. Text that also
// turns up in the body of pages is kept: in screenplays a character cue often lands at a page edge.
function dropRunningHeaders(pages: PageLine[][]): PageLine[][] {
  const edge = (lines: PageLine[], i: number) => i < 2 || i >= lines.length - 2;
  const edgeCounts = new Map<string, number>();
  const bodyCounts = new Map<string, number>();
  for (const lines of pages) {
    const atEdge = new Set<string>();
    const inBody = new Set<string>();
    lines.forEach((l, i) => (edge(lines, i) ? atEdge : inBody).add(headerKey(l.text)));
    for (const key of atEdge) edgeCounts.set(key, (edgeCounts.get(key) ?? 0) + 1);
    for (const key of inBody) bodyCounts.set(key, (bodyCounts.get(key) ?? 0) + 1);
  }
  const threshold = Math.max(3, pages.length * 0.4);
  const isHeader = (key: string) => {
    const atEdge = edgeCounts.get(key) ?? 0;
    return atEdge >= threshold && (bodyCounts.get(key) ?? 0) < atEdge * 0.5;
  };
  return pages.map((lines) => lines.filter((l, i) => !(edge(lines, i) && (PAGE_NUMBER_RE.test(l.text) || isHeader(headerKey(l.text))))));
}

// Inserts a blank line where the vertical gap is clearly larger than normal line spacing.
function withParagraphBreaks(lines: PageLine[]): string {
  if (lines.length < 2) return lines.map((l) => l.text).join("\n");
  const gaps = lines.slice(1).map((l, i) => lines[i]!.y - l.y).filter((g) => g > 0).sort((a, b) => a - b);
  const typical = gaps[Math.floor(gaps.length / 2)] ?? 0;
  return lines
    .map((l, i) => {
      const gap = i > 0 ? lines[i - 1]!.y - l.y : 0;
      return (typical && gap > typical * 1.6 ? "\n" : "") + l.text;
    })
    .join("\n");
}
