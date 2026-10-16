// Keeping the words being read in view: the visible band is the space between the pinned top row
// and the bottom player bar. Inside its comfortable middle nothing moves, so the page doesn't
// jitter word by word; outside it the page scrolls once to bring the word back up.

export interface Band {
  top: number;
  bottom: number;
}

/** Where the scrolled-to element's top lands, as a share of the band from its top. */
export const FOLLOW_AT = 0.3;
/** The comfortable middle: this share of the band is kept clear at the top and at the bottom. */
export const COMFORT_TOP = 0.12;
export const COMFORT_BOTTOM = 0.3;

/**
 * How far to scroll (positive: down the page) so `rect` sits comfortably in `band`, or 0 when it
 * already does. A rect taller than the band lines its top up with the band's top.
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

const reducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

/** The band inside `root`'s page: below the pinned run-through row, above the player bar. */
export function visibleBand(root: HTMLElement | null): Band {
  const bar = root?.querySelector(".runthrough-bar")?.getBoundingClientRect();
  const controls = root?.querySelector(".player-controls")?.getBoundingClientRect();
  const top = bar && bar.bottom > 0 ? bar.bottom : 0;
  const bottom = controls && controls.top < window.innerHeight ? controls.top : window.innerHeight;
  return { top, bottom };
}

/** Scrolls the page so `el` sits in the band, smoothly unless reduced motion is asked for. */
export function keepInView(el: Element, root: HTMLElement | null) {
  const delta = followDelta(el.getBoundingClientRect(), visibleBand(root));
  // An absolute target: asked again mid-scroll (the line, then its word), it names the same spot
  // instead of adding up.
  if (delta) window.scrollTo({ top: Math.max(0, window.scrollY + delta), behavior: reducedMotion() ? "auto" : "smooth" });
}
