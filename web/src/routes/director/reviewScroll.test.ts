import { describe, expect, it } from "vitest";
import { BAND_PAD, fieldScrollDelta, lineInView, scrollTarget, type ScrollGeometry } from "./reviewScroll";

// A 375 × 812 phone: header + review bar end at 171px. Desktop: bars end at 131px of 800.
const phone = { bandTop: 171, bandBottom: 812, maxScroll: 100_000 };
const phoneWithSheet = { ...phone, bandBottom: 309 };
const desktop = { bandTop: 131, bandBottom: 800, maxScroll: 100_000 };

const at = (g: ScrollGeometry) => {
  const y = scrollTarget(g);
  return { y, top: g.lineTop - y, bottom: g.lineTop - y + g.lineHeight };
};

describe("scrolling a review line into view", () => {
  it("centres a line in the band below the sticky bars, not the viewport", () => {
    const { top, bottom } = at({ ...desktop, lineTop: 5000, lineHeight: 80 });
    const middle = (top + bottom) / 2;
    expect(Math.abs(middle - (131 + 800) / 2)).toBeLessThanOrEqual(1);
    expect(top).toBeGreaterThan(131);
  });

  it("centres the line with its editor when both fit", () => {
    const { top } = at({ ...desktop, lineTop: 5000, lineHeight: 80, editorHeight: 300 });
    expect(Math.abs(top + (80 + 300) / 2 - (131 + 800) / 2)).toBeLessThanOrEqual(1);
  });

  it("keeps the line just under the bars on a phone when the editor is taller than the screen", () => {
    // The bug: centring the list item (line + 700px editor) pushed the line behind the review bar.
    const { top, bottom } = at({ ...phone, lineTop: 9000, lineHeight: 100, editorHeight: 700 });
    expect(top).toBe(171 + BAND_PAD);
    expect(bottom).toBeLessThan(812);
  });

  it("fits the line between the bars and the source sheet", () => {
    const { top, bottom } = at({ ...phoneWithSheet, lineTop: 9000, lineHeight: 84 });
    expect(top).toBeGreaterThanOrEqual(171);
    expect(bottom).toBeLessThanOrEqual(309);
  });

  it("starts a line taller than the band at the top of the band", () => {
    const { top } = at({ ...phone, lineTop: 3000, lineHeight: 1400 });
    expect(top).toBe(171 + BAND_PAD);
  });

  it("brings a nearby scene heading into view with the line", () => {
    // Centring alone would leave a heading 330px above the line under the bar.
    const g = { ...desktop, lineTop: 5000, lineHeight: 80, headingTop: 4670 };
    const y = scrollTarget(g);
    expect(4670 - y).toBe(131 + BAND_PAD);
    expect(5000 + 80 - y).toBeLessThan(800);
  });

  it("ignores a heading that's far above, or that wouldn't fit with the line", () => {
    const far = { ...desktop, lineTop: 5000, lineHeight: 80, headingTop: 4000 };
    expect(scrollTarget(far)).toBe(scrollTarget({ ...far, headingTop: null }));
    const tight = { ...phoneWithSheet, lineTop: 5000, lineHeight: 84, headingTop: 4800 };
    expect(scrollTarget(tight)).toBe(scrollTarget({ ...tight, headingTop: null }));
  });

  it("stays within the page", () => {
    expect(scrollTarget({ ...desktop, lineTop: 150, lineHeight: 40 })).toBe(0);
    expect(scrollTarget({ ...desktop, lineTop: 9990, lineHeight: 40, maxScroll: 9500 })).toBe(9500);
  });

  it("knows when a line is in view", () => {
    const g = { ...desktop, lineTop: 5000, lineHeight: 80 };
    expect(lineInView(g, scrollTarget(g))).toBe(true);
    expect(lineInView(g, 5000 - 100)).toBe(false); // under the review bar
    expect(lineInView(g, 4000)).toBe(false); // below the fold
  });
});

describe("keeping the field being edited above the keyboard", () => {
  // A phone: sticky bars end at 300, the keyboard starts at 560.
  const band = { top: 300, bottom: 560 };

  it("leaves a field that is already in view", () => {
    expect(fieldScrollDelta({ top: 340, bottom: 400 }, band)).toBe(0);
  });

  it("brings a field hidden by the keyboard up under the bars", () => {
    expect(fieldScrollDelta({ top: 640, bottom: 700 }, band)).toBe(640 - 312);
  });

  it("brings a field hidden behind the bars down", () => {
    expect(fieldScrollDelta({ top: 200, bottom: 260 }, band)).toBe(200 - 312);
  });

  it("shows the end of a tall field when the caret is at the end", () => {
    expect(fieldScrollDelta({ top: 400, bottom: 900 }, band, true)).toBe(900 - 548);
    expect(fieldScrollDelta({ top: 400, bottom: 900 }, band, false)).toBe(400 - 312);
  });

  it("doesn't move a tall field that already fills the band while typing", () => {
    expect(fieldScrollDelta({ top: 250, bottom: 900 }, band, true)).toBe(0);
  });
});
