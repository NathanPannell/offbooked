import { describe, expect, it } from "vitest";
import { followDelta } from "./follow";

// A phone: pinned row ends at 52 px, player bar starts at 720 px (band 668 px tall).
const band = { top: 52, bottom: 720 };

describe("followDelta", () => {
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
