import { describe, expect, it } from "vitest";
import { anchorDelta } from "../../player/follow";
import { bandBetweenRects, followIndex } from "./recorderFollow";

describe("bandBetweenRects", () => {
  it("is the space between a pinned header and the dock", () => {
    expect(bandBetweenRects({ bottom: 56 }, { top: 700 }, 844)).toEqual({ top: 56, bottom: 700 });
  });

  it("falls back to the viewport's edges for a missing or off-screen bar", () => {
    expect(bandBetweenRects(null, undefined, 844)).toEqual({ top: 0, bottom: 844 });
    expect(bandBetweenRects({ bottom: -20 }, { top: 900 }, 844)).toEqual({ top: 0, bottom: 844 });
  });

  it("puts a studio word under the app header's edge, not under the header (390 × 844 phone)", () => {
    // The director's studio: a 56 px pinned app header and a 150 px dock. Measured from the top of
    // the screen instead, the word would be held 24 px higher, under more of the header.
    const band = bandBetweenRects({ bottom: 56 }, { top: 694 }, 844);
    const word = { top: 800, bottom: 828 };
    const held = word.top - anchorDelta(word, band);
    expect(held).toBeGreaterThan(56 + (694 - 56) * 0.4);
    expect(held).toBeLessThan(56 + (694 - 56) * 0.45);
  });
});

describe("followIndex", () => {
  // "I'm here — now": I'm = tokens 0–2, here = 2–3, the dash has none, now = 3–4.
  const words = [
    { start: 0, end: 2 },
    { start: 2, end: 3 },
    { start: 3, end: 3 },
    { start: 3, end: 4 },
  ];

  it("follows the next word to say", () => {
    expect(followIndex(words, 0)).toBe(0);
    expect(followIndex(words, 1)).toBe(0);
    expect(followIndex(words, 2)).toBe(1);
  });

  it("never follows a word with nothing to say", () => {
    expect(followIndex(words, 3)).toBe(3);
  });

  it("stays on the last word once the line is said, and on nothing without words", () => {
    expect(followIndex(words, 4)).toBe(3);
    expect(followIndex(words, 99)).toBe(3);
    expect(followIndex([], 0)).toBe(-1);
  });
});
