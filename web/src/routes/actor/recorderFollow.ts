import { useEffect, useRef, type RefObject } from "react";
import { afterTakeDelta, keepInView, type Band } from "../../player/follow";
import type { LiveTakeView } from "../../stt/useLiveTake";

// Keeping the line being recorded in the middle of the screen, hands free, on both recorders (the
// cast's and the director's studio). The words to follow are LineCard's word spans, which carry the
// tracker's token range while a take records.

/** A scroll by hand pauses the follow this long. */
export const HAND_SCROLL_PAUSE_MS = 2500;

/**
 * The visible band between a pinned top (its bottom edge, if it is on screen) and a pinned bottom
 * (its top edge, if it is on screen), else the viewport's edges.
 */
export function bandBetweenRects(top: { bottom: number } | null | undefined, bottom: { top: number } | null | undefined, viewportHeight: number): Band {
  return {
    top: top && top.bottom > 0 ? Math.min(top.bottom, viewportHeight) : 0,
    bottom: bottom && bottom.top < viewportHeight && bottom.top > 0 ? bottom.top : viewportHeight,
  };
}

/**
 * The director's studio band: below the app's pinned header (the studio's own title and back link
 * scroll away with the page), above the record dock. `recorderBand` looks for the cast recorder's
 * pinned `.record-header`, which the studio doesn't have.
 */
export function studioBand(): Band {
  return bandBetweenRects(
    document.querySelector(".app-header")?.getBoundingClientRect(),
    document.querySelector(".record-dock")?.getBoundingClientRect(),
    window.innerHeight,
  );
}

/** A word span's tracker tokens, [start, end), from LineCard's data attributes. */
export interface WordSpan {
  start: number;
  end: number;
}

/**
 * Which word to keep in view for a "said up to token N" cursor: the next word to say (the first
 * with tokens of its own not yet all said), else the last word.
 */
export function followIndex(words: readonly WordSpan[], cursor: number): number {
  if (words.length === 0) return -1;
  const next = words.findIndex((w) => w.end > w.start && w.end > cursor);
  return next >= 0 ? next : words.length - 1;
}

/** The element to follow in a line card for `cursor`, or null when the card shows no words. */
export function followElement(card: Element | null | undefined, cursor: number): Element | null {
  const spans = [...(card?.querySelectorAll<HTMLElement>("[data-tok-end]") ?? [])];
  const i = followIndex(
    spans.map((s) => ({ start: Number(s.dataset.tokStart), end: Number(s.dataset.tokEnd) })),
    cursor,
  );
  return i >= 0 ? spans[i]! : null;
}

const reducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

/** After a take: the next card in the middle of `band`, the last take's buttons still in view above it. */
export function revealAfterTakeIn(takeCard: Element | null, nextCard: Element, band: Band) {
  const delta = afterTakeDelta(takeCard?.querySelector(".take-bar")?.getBoundingClientRect() ?? null, nextCard.getBoundingClientRect(), band);
  if (Math.abs(delta) < 2) return;
  window.scrollBy({ top: delta, behavior: reducedMotion() ? "auto" : "smooth" });
}

/**
 * While a take records, keeps the next word to say near the middle of `band`, karaoke style: as
 * the transcript moves the cursor, or, before the speech model is ready, at an average reading
 * pace from the actor's speech time, so a long speech still scrolls by itself. A scroll by hand
 * pauses it for a moment. The line's first words are put in view as the take starts.
 */
export function useFollowWhileRecording({
  recordingLineId,
  live,
  cardRefs,
  band,
}: {
  recordingLineId: string | null;
  live: LiveTakeView | null;
  cardRefs: RefObject<Map<string, HTMLElement>>;
  band: () => Band;
}) {
  const scrolledAt = useRef(0);
  const bandRef = useRef(band);
  bandRef.current = band;
  useEffect(() => {
    const mark = () => (scrolledAt.current = performance.now());
    window.addEventListener("touchmove", mark, { passive: true });
    window.addEventListener("wheel", mark, { passive: true });
    return () => {
      window.removeEventListener("touchmove", mark);
      window.removeEventListener("wheel", mark);
    };
  }, []);
  const lineId = live?.lineId === recordingLineId ? recordingLineId : null;
  const cursor = live ? (live.mode === "live" ? live.cursor : live.paced) : 0;
  useEffect(() => {
    if (!lineId) return;
    if (performance.now() - scrolledAt.current < HAND_SCROLL_PAUSE_MS) return;
    const el = followElement(cardRefs.current?.get(lineId), cursor);
    if (el) keepInView(el, null, () => bandRef.current());
  }, [lineId, cursor, cardRefs]);
}
