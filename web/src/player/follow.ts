// Keeping the words being read in view: the visible band is the space between the pinned top row
// and the bottom player bar. While the play runs, the row of text being read is held at one height
// in that band (FOLLOW_ANCHOR): each time a new row starts, the page glides up by about one row, so
// a long speech scrolls steadily instead of jumping. Words within a row never move the page.
// With reduced motion the page instead stays put while the word is in the band's comfortable middle
// and jumps once when it leaves it.

export interface Band {
  top: number;
  bottom: number;
}

/** Where the current row's top is held, as a share of the band from its top. */
export const FOLLOW_ANCHOR = 0.36;
/** Closer to the anchor than this (px) and the page stays put: less than one row of script text. */
export const ROW_SLACK = 12;

/** Reduced motion: where the scrolled-to element's top lands, as a share of the band from its top. */
export const FOLLOW_AT = 0.3;
/** Reduced motion: this share of the band is kept clear at the top and at the bottom. */
export const COMFORT_TOP = 0.12;
export const COMFORT_BOTTOM = 0.3;

/**
 * How far to scroll (positive: down the page) so `rect`'s top sits at the anchor of `band`, or 0
 * when it is already within a row's slack of it.
 */
export function anchorDelta(rect: { top: number }, band: Band): number {
  const h = band.bottom - band.top;
  if (h <= 0) return 0;
  const delta = rect.top - (band.top + h * FOLLOW_ANCHOR);
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
export function followTarget(
  rect: { top: number; bottom: number },
  band: Band,
  page: { scrollY: number; maxScroll: number },
  reduced: boolean,
): number | null {
  const delta = reduced ? followDelta(rect, band) : anchorDelta(rect, band);
  if (!delta) return null;
  const top = Math.max(0, Math.min(page.maxScroll, page.scrollY + delta));
  return Math.abs(top - page.scrollY) < 2 ? null : top;
}

const reducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

/** The band inside `root`'s page: below the pinned run-through row, above the player bar. */
export function visibleBand(root: HTMLElement | null): Band {
  const bar = root?.querySelector(".runthrough-bar")?.getBoundingClientRect();
  const controls = root?.querySelector(".player-controls")?.getBoundingClientRect();
  const top = bar && bar.bottom > 0 ? bar.bottom : 0;
  const bottom = controls && controls.top < window.innerHeight ? controls.top : window.innerHeight;
  return { top, bottom };
}

/** The last smooth scroll asked for, so asking again mid-glide doesn't restart it. */
let gliding: { top: number; at: number } | null = null;

/** Scrolls the page so `el` is followed in the band, smoothly unless reduced motion is asked for. */
export function keepInView(el: Element, root: HTMLElement | null) {
  const reduced = reducedMotion();
  const maxScroll = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
  const top = followTarget(el.getBoundingClientRect(), visibleBand(root), { scrollY: window.scrollY, maxScroll }, reduced);
  if (top === null) return;
  const now = performance.now();
  // An absolute target: asked again mid-glide (the line, then its word), it names the same spot
  // instead of adding up, and the same spot isn't asked for twice.
  if (!reduced && gliding && Math.abs(gliding.top - top) < 4 && now - gliding.at < 800) return;
  gliding = reduced ? null : { top, at: now };
  window.scrollTo({ top, behavior: reduced ? "auto" : "smooth" });
}
