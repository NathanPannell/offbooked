// Bringing a line of the script review into view, below the sticky bars and above the source
// sheet on phones, with its scene heading when that's close by.
//
// `scrollIntoView` isn't enough here: it centres the whole list item (the line plus its inline
// editor, which on a phone is taller than the screen), it doesn't know about the sticky bars or
// the bottom sheet, and on a long hop the scenes in between are skipped by `content-visibility:
// auto`, so their estimated heights change as the page scrolls past and the target moves.

export interface ScrollGeometry {
  /** The line's row, in document coordinates (px from the top of the page). */
  lineTop: number;
  lineHeight: number;
  /** The inline editor under the line, when it's open. */
  editorHeight?: number;
  /** The scene heading above the line, in document coordinates. */
  headingTop?: number | null;
  /** The visible band of the viewport: below the sticky bars, above any bottom sheet. */
  bandTop: number;
  bandBottom: number;
  /** The largest possible scrollY. */
  maxScroll: number;
}

/** Breathing room between the band's edge and the line (room for the join control above it). */
export const BAND_PAD = 20;
/** A heading this close above the line (px) is brought into view with it, when everything fits. */
export const HEADING_NEAR = 360;

/**
 * The scrollY that shows the line well: the line (and its editor, when both fit) centred in the
 * visible band; a line too tall for the band starts at the top of it. A nearby scene heading is
 * kept in view when it fits along with the line.
 */
export function scrollTarget(g: ScrollGeometry): number {
  const band = Math.max(0, g.bandBottom - g.bandTop);
  const room = band - 2 * BAND_PAD;
  const withEditor = g.lineHeight + (g.editorHeight ?? 0);
  let y: number;
  if (withEditor <= room) {
    // Centre the line and its editor together.
    y = g.lineTop + withEditor / 2 - (g.bandTop + band / 2);
  } else if (g.lineHeight <= room && g.editorHeight) {
    // The editor doesn't fit as well: keep the line near the top so the editor follows it.
    y = g.lineTop - g.bandTop - BAND_PAD;
  } else if (g.lineHeight <= room) {
    y = g.lineTop + g.lineHeight / 2 - (g.bandTop + band / 2);
  } else {
    y = g.lineTop - g.bandTop - BAND_PAD;
  }
  if (g.headingTop != null) {
    const gap = g.lineTop - g.headingTop;
    // Show the heading too if it's just above and the heading-to-line block still fits.
    if (gap >= 0 && gap <= HEADING_NEAR && gap + g.lineHeight <= room) {
      y = Math.min(y, g.headingTop - g.bandTop - BAND_PAD);
    }
  }
  return Math.round(Math.min(Math.max(0, y), Math.max(0, g.maxScroll)));
}

/** True when the line sits fully inside the band (or fills it, for a very tall line). */
export function lineInView(g: Pick<ScrollGeometry, "lineTop" | "lineHeight" | "bandTop" | "bandBottom">, scrollY: number): boolean {
  const top = g.lineTop - scrollY;
  const bottom = top + g.lineHeight;
  if (g.lineHeight > g.bandBottom - g.bandTop) return top <= g.bandTop + BAND_PAD + 1 && bottom >= g.bandBottom;
  return top >= g.bandTop - 1 && bottom <= g.bandBottom + 1;
}

// ---- DOM ----

const reducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

/**
 * The visible band of the review: under the sticky header and review bar, above the source sheet
 * and above the on-screen keyboard. Phones shrink only the visual viewport for the keyboard, so
 * window.innerHeight still includes the part it covers.
 */
export function visibleBand(): { top: number; bottom: number } {
  const bar = document.querySelector<HTMLElement>(".review-bar");
  const vv = window.visualViewport;
  const vvTop = vv ? vv.offsetTop : 0;
  const top = Math.max(vvTop, bar ? Math.max(0, bar.getBoundingClientRect().bottom) : 0);
  let bottom = vv ? Math.min(window.innerHeight, vvTop + vv.height) : window.innerHeight;
  const sheet = document.querySelector<HTMLElement>(".source-open .source-pane");
  if (sheet && getComputedStyle(sheet).position === "fixed") bottom = Math.min(bottom, sheet.getBoundingClientRect().top);
  return { top, bottom };
}

function measure(lineId: string): ScrollGeometry | null {
  const item = document.getElementById(`line-${lineId}`);
  const row = item?.querySelector<HTMLElement>(".script-row");
  if (!item || !row) return null;
  const y = window.scrollY;
  const r = row.getBoundingClientRect();
  const editor = item.querySelector<HTMLElement>(".line-editor");
  const section = item.closest<HTMLElement>(".script-section");
  const heading = section?.querySelector<HTMLElement>(".section-head");
  const band = visibleBand();
  return {
    lineTop: r.top + y,
    lineHeight: r.height,
    editorHeight: editor?.getBoundingClientRect().height ?? 0,
    headingTop: heading ? heading.getBoundingClientRect().top + y : null,
    bandTop: band.top,
    bandBottom: band.bottom,
    maxScroll: document.documentElement.scrollHeight - window.innerHeight,
  };
}

let current = 0;

/**
 * Scrolls the page so the line shows well, then checks where it actually landed and corrects:
 * scenes skipped by content-visibility change height as they render, which moves the target.
 * A newer call cancels an older one.
 */
export function scrollToLine(lineId: string, { smooth = true }: { smooth?: boolean } = {}): void {
  const id = ++current;
  const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
  void (async () => {
    // Let React's commit (the editor opening or closing) reach layout first.
    await frame();
    for (let attempt = 0; attempt < 4; attempt++) {
      if (id !== current) return;
      const g = measure(lineId);
      if (!g) return;
      const target = scrollTarget(g);
      const distance = Math.abs(target - window.scrollY);
      if (distance < 3) return;
      // Long hops jump: a smooth scroll over unrendered scenes misses, and it takes too long anyway.
      const animate = smooth && attempt === 0 && !reducedMotion() && distance < window.innerHeight * 1.5;
      window.scrollTo({ top: target, behavior: animate ? "smooth" : "auto" });
      if (animate) await settled();
      else {
        await frame();
        await frame();
      }
    }
  })();
}

/** Resolves when a smooth scroll has stopped (scrollend, or no movement for a few frames). */
function settled(): Promise<void> {
  return new Promise((resolve) => {
    let last = window.scrollY;
    let still = 0;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      window.removeEventListener("scrollend", finish);
      resolve();
    };
    window.addEventListener("scrollend", finish, { once: true });
    const tick = () => {
      if (done) return;
      const y = window.scrollY;
      still = y === last ? still + 1 : 0;
      last = y;
      if (still >= 6) finish();
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    setTimeout(finish, 1200);
  });
}

/**
 * How far to scroll so a text field being edited sits in the visible band: unchanged when it
 * already fits, else its top just under the sticky bars (room below for the text to grow), or, for
 * a field taller than the band, its bottom (where the caret usually is) just above the keyboard.
 */
export function fieldScrollDelta(field: { top: number; bottom: number }, band: { top: number; bottom: number }, caretAtEnd = false): number {
  const pad = 12;
  const fits = field.bottom - field.top <= band.bottom - band.top - 2 * pad;
  if (field.top >= band.top + pad - 1 && field.bottom <= band.bottom - pad + 1) return 0;
  // A tall field that already fills the band: leave it, so typing in it doesn't jump the page.
  if (!fits && field.top <= band.top + pad + 1 && field.bottom >= band.bottom - pad - 1) return 0;
  if (fits || !caretAtEnd) return Math.round(field.top - (band.top + pad));
  return Math.round(field.bottom - (band.bottom - pad));
}

/** Keeps the field being edited above the keyboard and below the sticky bars. */
export function keepFieldInView(el: HTMLTextAreaElement | null): void {
  if (!el) return;
  current++; // a hop still settling would scroll it away again
  const r = el.getBoundingClientRect();
  const caretAtEnd = el.selectionEnd >= el.value.length - 1;
  const delta = fieldScrollDelta({ top: r.top, bottom: r.bottom }, visibleBand(), caretAtEnd);
  if (delta) window.scrollBy({ top: delta, behavior: "auto" });
}
