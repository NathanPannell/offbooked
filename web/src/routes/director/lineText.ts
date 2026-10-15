import type { LineKind } from "../../api/types";

// Showing and editing a line's text in place.

export interface TextRun {
  text: string;
  /** A [bracketed] direction inside a spoken line. */
  direction: boolean;
}

/**
 * A line's text cut into plain runs and [bracketed] directions. Only spoken lines have inline
 * directions; the runs join back to exactly the original text.
 */
export function textRuns(text: string, kind: LineKind): TextRun[] {
  if (kind !== "dialogue" || !text.includes("[")) return [{ text, direction: false }];
  const out: TextRun[] = [];
  const re = /\[[^\]]*\]/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push({ text: text.slice(last, m.index), direction: false });
    out.push({ text: m[0], direction: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), direction: false });
  return out;
}

/**
 * Where a split at the caret would cut, as the server's `split` takes it, or null when one side
 * would be empty (it trims both halves).
 */
export function splitAtCaret(text: string, caret: number): number | null {
  if (caret <= 0 || caret >= text.length) return null;
  return text.slice(0, caret).trim() && text.slice(caret).trim() ? caret : null;
}

/** The character offset inside `container`'s text under a click, or null when the browser can't say. */
export function caretOffsetAt(container: HTMLElement, x: number, y: number): number | null {
  const doc = container.ownerDocument as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  let node: Node | null = null;
  let offset = 0;
  const pos = doc.caretPositionFromPoint?.(x, y);
  if (pos) {
    node = pos.offsetNode;
    offset = pos.offset;
  } else {
    const range = doc.caretRangeFromPoint?.(x, y);
    if (range) {
      node = range.startContainer;
      offset = range.startOffset;
    }
  }
  if (!node || !container.contains(node)) return null;
  if (node.nodeType !== Node.TEXT_NODE) return null;
  let total = 0;
  const walker = doc.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n === node) return total + offset;
    total += n.textContent?.length ?? 0;
  }
  return null;
}
