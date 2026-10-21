// Keeping the words being read (or recorded) in view, karaoke style: the visible band is the space
// between a pinned top row and a bottom bar (the run-through's player bar, the recorder's dock). The
// row of text being read is held near the middle of that band (FOLLOW_ANCHOR), but never so low that
// fewer than LOOKAHEAD_ROWS rows show beneath it. Each time a new row starts, the page glides up by
// about one row, so a long speech scrolls steadily instead of jumping. Words within a row never move
// the page.
// With reduced motion the page instead stays put while the word is in the band's comfortable middle
// and jumps once when it leaves it.
// The run-through only follows rows on a long line (`lineDelta`): a line that fits in the band with
// the end of its cue above it and the lookahead rows below is placed once, as it starts, and the
// page stays put while it plays.

export interface Band {
  top: number;
  bottom: number;
}

/** Where the current row's top is held, as a share of the band from its top: about the middle. */
export const FOLLOW_ANCHOR = 0.42;
/** Rows of text that always stay visible below the current one. */
export const LOOKAHEAD_ROWS = 3;
/** Closer to the anchor than this (px) and the page stays put: less than one row of script text. */
export const ROW_SLACK = 12;

/** Reduced motion: where the scrolled-to element's top lands, as a share of the band from its top. */
export const FOLLOW_AT = 0.3;
/** Reduced motion: this share of the band is kept clear at the top and at the bottom. */
export const COMFORT_TOP = 0.12;
export const COMFORT_BOTTOM = 0.3;

/**
 * Where the current row's top is held in `band`: the anchor, raised when needed so the row and the
 * LOOKAHEAD_ROWS rows after it (each `rowHeight` tall) fit above the band's bottom.
 */
export function anchorTop(band: Band, rowHeight: number): number {
  const h = band.bottom - band.top;
  const lowest = band.bottom - rowHeight * (LOOKAHEAD_ROWS + 1);
  return Math.max(band.top, Math.min(band.top + h * FOLLOW_ANCHOR, lowest));
}

/**
 * How far to scroll (positive: down the page) so `rect`'s top sits at the anchor of `band`, or 0
 * when it is already within a row's slack of it. `rect`'s height is taken as one row.
 */
export function anchorDelta(rect: { top: number; bottom?: number }, band: Band): number {
  const h = band.bottom - band.top;
  if (h <= 0) return 0;
  const row = rect.bottom !== undefined && rect.bottom > rect.top ? Math.min(rect.bottom - rect.top, 80) : 32;
  const delta = rect.top - anchorTop(band, row);
  return Math.abs(delta) < ROW_SLACK ? 0 : delta;
}

/**
 * Reduced motion: how far to scroll so `rect` sits comfortably in `band`, or 0 when it already
 * does. A rect taller than the band lines its top up with the band's top.
 */
export function followDelta(rect: { top: number; bottom: number }, band: Band): number {
  const h = band.bottom - band.top;
  if (h <= 0) return 0;
  const lo = band.top + h * COMFORT_TOP;
  const hi = band.bottom - h * COMFORT_BOTTOM;
  if (rect.top >= lo && rect.bottom <= hi) return 0;
  const tall = rect.bottom - rect.top > h * (1 - FOLLOW_AT) - 8;
  const target = tall ? band.top + 8 : band.top + h * FOLLOW_AT;
  const delta = rect.top - target;
  return Math.abs(delta) < 4 ? 0 : delta;
}

/**
 * The page offset to scroll to so `rect` is followed, or null to stay put: anchored rows normally,
 * the comfort band with reduced motion. Clamped to what the page can scroll.
 */
export function followTarget(rect: { top: number; bottom: number }, band: Band, page: { scrollY: number; maxScroll: number }, reduced: boolean): number | null {
  const delta = reduced ? followDelta(rect, band) : anchorDelta(rect, band);
  if (!delta) return null;
  const top = Math.max(0, Math.min(page.maxScroll, page.scrollY + delta));
  return Math.abs(top - page.scrollY) < 2 ? null : top;
}

const reducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

/** The band between whatever is pinned at the top (`topSelector`) and at the bottom (`bottomSelector`). */
function bandBetween(root: ParentNode | null, topSelector: string, bottomSelector: string): Band {
  const bar = root?.querySelector(topSelector)?.getBoundingClientRect();
  const foot = root?.querySelector(bottomSelector)?.getBoundingClientRect();
  const top = bar && bar.bottom > 0 ? bar.bottom : 0;
  const bottom = foot && foot.top < window.innerHeight ? foot.top : window.innerHeight;
  return { top, bottom };
}

/** At most this many rows of the cue (the line before) have to fit above a line for it to count as short. */
export const CUE_ROWS = 3;

interface Rect {
  top: number;
  bottom: number;
}

/** A row's height: a word's own (capped), or a row of the current line's type. */
const rowOf = (rect: Rect | null) => (rect && rect.bottom > rect.top ? Math.min(rect.bottom - rect.top, 80) : 32);

/**
 * How far to scroll (positive: down the page) to follow the line being played in the run-through.
 * `line` is the line's text, `cue` the end of the line before it (its underlined cue, or its text),
 * `word` the word being said (null before the first). A short line, one that fits in the band with
 * up to CUE_ROWS rows of its cue above it and LOOKAHEAD_ROWS rows below, is placed as it starts
 * (`atStart`: its top at the anchor, or the comfort band with reduced motion, moved as little as
 * needed to keep the cue and the lookahead in view) and after that only moves if it no longer fits
 * where it is (its type grows as it becomes current). A long line follows its rows (`anchorDelta`).
 */
export function lineDelta(rects: { line: Rect; cue: Rect | null; word: Rect | null }, band: Band, atStart: boolean, reduced: boolean): number {
  const { line, cue, word } = rects;
  if (band.bottom - band.top <= 0) return 0;
  const row = rowOf(word);
  const top = cue ? Math.min(line.top, Math.max(cue.top, cue.bottom - CUE_ROWS * row)) : line.top;
  const least = line.bottom + LOOKAHEAD_ROWS * row - band.bottom; // keeps the rows below in view
  const most = top - band.top; // keeps the cue (or the line's top) in view
  if (least > most) {
    // Long: follow the row being read, starting from the line's first row.
    const at = word ?? { top: line.top, bottom: line.top + row };
    return reduced ? followDelta(at, band) : anchorDelta(at, band);
  }
  const wanted = atStart ? (reduced ? followDelta({ top: line.top, bottom: line.bottom }, band) : line.top - anchorTop(band, row)) : 0;
  const delta = Math.max(least, Math.min(most, wanted));
  return Math.abs(delta) < (atStart ? ROW_SLACK : 4) ? 0 : delta;
}

/** Room kept above the last take's buttons when they stay in view after moving on. */
export const TAKE_BAR_MARGIN = 8;

/**
 * After a take, how far to scroll (px, positive is down) so the next line's card sits in the middle
 * of the band, while the take just recorded keeps its Listen back / Redo / Delete row in view
 * above it. The next card staying whole wins over the old buttons; a next card taller than the
 * band starts at its top.
 */
export function afterTakeDelta(takeBar: { top: number } | null, next: { top: number; bottom: number }, band: Band): number {
  const height = band.bottom - band.top;
  const nextHeight = next.bottom - next.top;
  if (nextHeight >= height) return next.top - band.top;
  const centred = (next.top + next.bottom) / 2 - (band.top + band.bottom) / 2;
  const keepsBar = takeBar ? takeBar.top - band.top - TAKE_BAR_MARGIN : Infinity;
  const nextWhole = next.bottom - band.bottom; // the least scroll that keeps the next card's bottom in the band
  return Math.max(nextWhole, Math.min(centred, keepsBar));
}

/** Scrolls the recorder after a take: the next card centred, the last take's buttons still in view. */
export function revealAfterTake(takeCard: Element | null, nextCard: Element) {
  const delta = afterTakeDelta(takeCard?.querySelector(".take-bar")?.getBoundingClientRect() ?? null, nextCard.getBoundingClientRect(), recorderBand(null));
  if (Math.abs(delta) < 2) return;
  window.scrollBy({ top: delta, behavior: reducedMotion() ? "auto" : "smooth" });
}

/** The band inside `root`'s page: below the pinned run-through row, above the player bar. */
export function visibleBand(root: HTMLElement | null): Band {
  return bandBetween(root, ".runthrough-bar", ".player-controls");
}

/** The recorder's band: below its pinned header, above the record dock. */
export function recorderBand(root: HTMLElement | null): Band {
  return bandBetween(root ?? document, ".record-header", ".record-dock");
}

/** The last smooth scroll asked for, so asking again mid-glide doesn't restart it. */
let gliding: { top: number; at: number } | null = null;
/** How long a smooth scroll is taken to last. */
const GLIDE_MS = 800;

/**
 * Follows the run-through's current line (see `lineDelta`). Measured from where a glide still under
 * way will leave the page, so a word arriving mid-glide doesn't cut it short.
 */
export function followLine(line: Element, cue: Element | null, word: Element | null, root: HTMLElement | null, atStart: boolean) {
  const reduced = reducedMotion();
  const now = performance.now();
  const settling = !reduced && gliding && now - gliding.at < GLIDE_MS ? gliding.top - window.scrollY : 0;
  const shift = (r: DOMRect | undefined) => (r ? { top: r.top - settling, bottom: r.bottom - settling } : null);
  const delta = lineDelta(
    { line: shift(line.getBoundingClientRect())!, cue: shift(cue?.getBoundingClientRect()), word: shift(word?.getBoundingClientRect()) },
    visibleBand(root),
    atStart,
    reduced,
  );
  if (!delta) return;
  const from = window.scrollY + settling;
  const maxScroll = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
  const top = Math.max(0, Math.min(maxScroll, from + delta));
  if (Math.abs(top - from) < 2) return;
  gliding = reduced ? null : { top, at: now };
  window.scrollTo({ top, behavior: reduced ? "auto" : "smooth" });
}

/** Scrolls the page so `el` is followed in the band, smoothly unless reduced motion is asked for. */
export function keepInView(el: Element, root: HTMLElement | null, band: (root: HTMLElement | null) => Band = visibleBand) {
  const reduced = reducedMotion();
  const maxScroll = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
  const top = followTarget(el.getBoundingClientRect(), band(root), { scrollY: window.scrollY, maxScroll }, reduced);
  if (top === null) return;
  const now = performance.now();
  // An absolute target: asked again mid-glide (the line, then its word), it names the same spot
  // instead of adding up, and the same spot isn't asked for twice.
  if (!reduced && gliding && Math.abs(gliding.top - top) < 4 && now - gliding.at < GLIDE_MS) return;
  gliding = reduced ? null : { top, at: now };
  window.scrollTo({ top, behavior: reduced ? "auto" : "smooth" });
}
