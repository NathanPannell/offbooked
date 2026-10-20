import { describe, expect, it } from "vitest";
import { afterTakeDelta, anchorDelta, anchorTop, FOLLOW_ANCHOR, followDelta, followTarget, LOOKAHEAD_ROWS, ROW_SLACK, TAKE_BAR_MARGIN } from "./follow";

// A phone: pinned row ends at 52 px, player bar starts at 720 px (band 668 px tall).
const band = { top: 52, bottom: 720 };
const anchor = band.top + (band.bottom - band.top) * FOLLOW_ANCHOR;
// One row of the current line: 23 px type at 1.45 line height.
const ROW = 33;

describe("anchorDelta", () => {
  it("leaves a word on the anchored row alone", () => {
    expect(anchorDelta({ top: anchor }, band)).toBe(0);
    expect(anchorDelta({ top: anchor + 4 }, band)).toBe(0);
    expect(anchorDelta({ top: anchor - (ROW_SLACK - 1) }, band)).toBe(0);
  });

  it("moves about one row when the next row of a long speech starts", () => {
    // Every word of a row shares its top, so only the first word of each new row scrolls.
    const rows = [0, 1, 2, 3].map((r) => anchorDelta({ top: anchor + r * ROW }, band));
    expect(rows[0]).toBe(0);
    expect(rows[1]).toBeCloseTo(ROW, 5);
    expect(rows[2]).toBeCloseTo(2 * ROW, 5);
    expect(ROW).toBeGreaterThan(ROW_SLACK);
  });

  it("brings a far-off line to the anchor in either direction", () => {
    expect(anchorDelta({ top: 1400 }, band)).toBeCloseTo(1400 - anchor, 5);
    expect(anchorDelta({ top: -300 }, band)).toBeCloseTo(-300 - anchor, 5);
  });

  it("does nothing without a band", () => {
    expect(anchorDelta({ top: 500 }, { top: 100, bottom: 100 })).toBe(0);
  });
});

describe("followTarget", () => {
  const page = { scrollY: 1000, maxScroll: 5000 };

  it("names the absolute spot, so asking again mid-glide doesn't add up", () => {
    expect(followTarget({ top: anchor + ROW, bottom: anchor + 2 * ROW }, band, page, false)).toBeCloseTo(1000 + ROW, 5);
    // Halfway through that glide the same row names the same spot.
    const half = { scrollY: 1000 + ROW / 2, maxScroll: 5000 };
    expect(followTarget({ top: anchor + ROW / 2, bottom: anchor + ROW * 1.5 }, band, half, false)).toBeCloseTo(1000 + ROW, 5);
  });

  it("stays put within a row", () => {
    expect(followTarget({ top: anchor + 3, bottom: anchor + 36 }, band, page, false)).toBeNull();
  });

  it("clamps to the page and stays put when it can't move", () => {
    expect(followTarget({ top: 100, bottom: 130 }, band, { scrollY: 0, maxScroll: 5000 }, false)).toBeNull();
    expect(followTarget({ top: 900, bottom: 930 }, band, { scrollY: 4990, maxScroll: 5000 }, false)).toBe(5000);
  });

  it("with reduced motion, keeps the comfort band instead of following every row", () => {
    expect(followTarget({ top: 300, bottom: 330 }, band, page, true)).toBeNull();
    expect(followTarget({ top: 300 + ROW, bottom: 330 + ROW }, band, page, true)).toBeNull();
    expect(followTarget({ top: 600, bottom: 630 }, band, page, true)).toBeGreaterThan(1000);
  });
});

describe("followDelta (reduced motion)", () => {
  it("leaves a word in the comfortable middle alone", () => {
    expect(followDelta({ top: 300, bottom: 330 }, band)).toBe(0);
  });

  it("scrolls down once a word nears the player bar, bringing it to the upper third", () => {
    const delta = followDelta({ top: 600, bottom: 630 }, band);
    expect(delta).toBeGreaterThan(0);
    expect(600 - delta).toBeCloseTo(52 + 668 * 0.3, 0);
  });

  it("scrolls up when the word is under the pinned row or above the screen", () => {
    expect(followDelta({ top: 20, bottom: 50 }, band)).toBeLessThan(0);
    expect(followDelta({ top: -400, bottom: -370 }, band)).toBeLessThan(0);
  });

  it("lines a tall block up with the top of the band", () => {
    const delta = followDelta({ top: 600, bottom: 1300 }, band);
    expect(600 - delta).toBe(60);
  });

  it("does nothing without a band", () => {
    expect(followDelta({ top: 10, bottom: 20 }, { top: 100, bottom: 100 })).toBe(0);
  });
});

describe("three rows of lookahead", () => {
  it("holds the row near the middle when there's room below", () => {
    const tall = { top: 100, bottom: 900 };
    expect(anchorTop(tall, 30)).toBeCloseTo(100 + 800 * FOLLOW_ANCHOR, 5);
  });

  it("raises the row so three rows still show beneath it on a short band", () => {
    // A phone with a big record dock: 260px of band.
    const short = { top: 120, bottom: 380 };
    const top = anchorTop(short, 34);
    expect(top + 34 * (LOOKAHEAD_ROWS + 1)).toBeLessThanOrEqual(short.bottom);
    expect(top).toBeGreaterThanOrEqual(short.top);
  });

  it("uses the word's own height as the row", () => {
    const short = { top: 0, bottom: 300 };
    const delta = anchorDelta({ top: 200, bottom: 240 }, short);
    expect(200 - delta).toBeCloseTo(anchorTop(short, 40), 5);
  });
});

describe("afterTakeDelta", () => {
  const band = { top: 100, bottom: 700 }; // centre 400

  it("centres the next card when the last take's buttons stay in view", () => {
    // Next card 300–500 (centre 400): already centred.
    expect(afterTakeDelta({ top: 250 }, { top: 300, bottom: 500 }, band)).toBe(0);
    // Next card 600–800: scroll down 300 to centre it; the buttons at 550 land at 250, still in view.
    expect(afterTakeDelta({ top: 550 }, { top: 600, bottom: 800 }, band)).toBe(300);
  });

  it("scrolls less so the buttons don't slide under the header", () => {
    // Centring would take 300, but the buttons at 300 would end up at 0: stop with them just in view.
    expect(afterTakeDelta({ top: 300 }, { top: 600, bottom: 800 }, band)).toBe(300 - band.top - TAKE_BAR_MARGIN);
  });

  it("keeps the next card whole even if the buttons go", () => {
    // A tall next card (450 px) from 500: its bottom (950) must come up to 700, so at least 250.
    expect(afterTakeDelta({ top: 150 }, { top: 500, bottom: 950 }, band)).toBe(250);
  });

  it("starts a card taller than the band at its top", () => {
    expect(afterTakeDelta({ top: 150 }, { top: 500, bottom: 1300 }, band)).toBe(400);
  });

  it("just centres when there is no take on screen", () => {
    expect(afterTakeDelta(null, { top: 600, bottom: 800 }, band)).toBe(300);
  });
});
