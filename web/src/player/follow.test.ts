import { describe, expect, it } from "vitest";
import {
  afterTakeDelta,
  anchorDelta,
  anchorTop,
  CUE_ROWS,
  FOLLOW_ANCHOR,
  followDelta,
  followTarget,
  lineDelta,
  LOOKAHEAD_ROWS,
  ROW_SLACK,
  TAKE_BAR_MARGIN,
} from "./follow";

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

describe("lineDelta (the run-through's current line)", () => {
  // A word on the line's first row, and a line `rows` rows tall starting at `top`.
  const lineAt = (top: number, rows: number) => ({ top, bottom: top + rows * ROW });
  const wordOn = (top: number) => ({ top, bottom: top + ROW });
  const start = anchorTop(band, ROW);

  it("places a short line at the anchor as it starts", () => {
    const line = lineAt(900, 2);
    const cue = lineAt(830, 2);
    expect(lineDelta({ line, cue, word: null }, band, true, false)).toBeCloseTo(900 - start, 5);
  });

  it("keeps a short line still while it plays, whichever row is being read", () => {
    const line = lineAt(start, 3);
    const cue = lineAt(start - 70, 2);
    for (let r = 0; r < 3; r++) expect(lineDelta({ line, cue, word: wordOn(start + r * ROW) }, band, false, false)).toBe(0);
  });

  it("moves a short line mid-way only when it no longer fits where it is", () => {
    // It grew (its type gets bigger as it becomes current) and now crowds the player bar.
    const line = lineAt(560, 3);
    const delta = lineDelta({ line, cue: lineAt(480, 2), word: wordOn(560) }, band, false, false);
    expect(line.bottom + LOOKAHEAD_ROWS * ROW - delta).toBeCloseTo(band.bottom, 5);
  });

  it("counts a line as long when it doesn't fit with its cue and the lookahead", () => {
    // 15 rows: with 3 rows of cue and 3 below, 21 rows (693 px) don't fit in 668 px, so it follows rows.
    const line = lineAt(start, 15);
    const cue = lineAt(start - 3 * ROW, 3);
    expect(lineDelta({ line, cue, word: wordOn(start + 2 * ROW) }, band, false, false)).toBeCloseTo(2 * ROW, 5);
    // 13 rows (19 with cue and lookahead) still fit: it stays put mid-line.
    const fits = lineAt(band.top + 3 * ROW, 13);
    expect(lineDelta({ line: fits, cue: lineAt(band.top, 3), word: wordOn(fits.top + 5 * ROW) }, band, false, false)).toBe(0);
  });

  it("keeps the end of the cue in view above a short line", () => {
    const line = lineAt(400, 6);
    const cue = lineAt(400 - 2 * ROW, 2);
    const delta = lineDelta({ line, cue, word: null }, band, true, false);
    expect(cue.top - delta).toBeGreaterThanOrEqual(band.top);
    expect(line.bottom + LOOKAHEAD_ROWS * ROW - delta).toBeLessThanOrEqual(band.bottom);
  });

  it("only needs the last rows of a long cue", () => {
    const line = lineAt(1000, 4);
    const cue = lineAt(1000 - 30 * ROW, 30); // a long speech before a short reply
    const delta = lineDelta({ line, cue, word: null }, band, true, false);
    expect(delta).not.toBe(0);
    expect(cue.bottom - CUE_ROWS * ROW - delta).toBeGreaterThanOrEqual(band.top - 0.001);
    // And it stays put while it plays.
    expect(lineDelta({ line: lineAt(1000 - delta, 4), cue: lineAt(1000 - 30 * ROW - delta, 30), word: wordOn(1000 - delta + ROW) }, band, false, false)).toBe(
      0,
    );
  });

  it("follows a long line row by row, as anchorDelta does", () => {
    const line = lineAt(start, 20);
    expect(lineDelta({ line, cue: null, word: wordOn(start) }, band, false, false)).toBe(0);
    expect(lineDelta({ line, cue: null, word: wordOn(start + ROW) }, band, false, false)).toBeCloseTo(ROW, 5);
    // Starting, it puts the first row at the anchor.
    expect(lineDelta({ line: lineAt(900, 20), cue: null, word: null }, band, true, false)).toBeCloseTo(anchorDelta(wordOn(900), band), 5);
  });

  it("always leaves the lookahead rows in view below a short line", () => {
    const short = { top: 100, bottom: 400 };
    const line = lineAt(250, 2);
    const delta = lineDelta({ line, cue: null, word: null }, short, true, false);
    expect(line.bottom + LOOKAHEAD_ROWS * ROW - delta).toBeLessThanOrEqual(short.bottom);
  });

  it("with reduced motion, places a short line in the comfort band once", () => {
    expect(lineDelta({ line: lineAt(300, 2), cue: lineAt(230, 2), word: null }, band, true, true)).toBe(0);
    const delta = lineDelta({ line: lineAt(900, 2), cue: lineAt(830, 2), word: null }, band, true, true);
    expect(delta).toBeCloseTo(followDelta(lineAt(900, 2), band), 5);
    expect(lineDelta({ line: lineAt(900 - delta, 2), cue: null, word: wordOn(900 - delta + ROW) }, band, false, true)).toBe(0);
  });

  it("does nothing without a band", () => {
    expect(lineDelta({ line: lineAt(500, 2), cue: null, word: null }, { top: 100, bottom: 100 }, true, false)).toBe(0);
  });
});
