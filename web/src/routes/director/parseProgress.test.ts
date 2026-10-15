import { describe, expect, it } from "vitest";
import { describeProgress } from "./parseProgress";

describe("describeProgress", () => {
  it("starts indeterminate while reading", () => {
    expect(describeProgress(null)).toEqual({ stage: 0, fraction: null, counts: [] });
    expect(describeProgress({ stage: "reading", pages: 97 }, "en-US")).toEqual({ stage: 0, fraction: null, counts: ["97 pages"] });
  });

  it("counts lines, scenes and speeches while labelling", () => {
    const view = describeProgress(
      { stage: "labelling", pages: 97, chunksDone: 12, chunksTotal: 29, linesDone: 2340, linesTotal: 5190, scenes: 14, speeches: 612 },
      "en-US",
    );
    expect(view.stage).toBe(1);
    expect(view.fraction).toBeCloseTo(2340 / 5190);
    expect(view.counts.join(" · ")).toBe("97 pages · 2,340 of 5,190 lines · 14 scenes · 612 speeches found");
  });

  it("uses singular words and skips unknown counts", () => {
    expect(describeProgress({ stage: "labelling", linesDone: 0, linesTotal: 1, scenes: 1, speeches: 1 }, "en-US").counts).toEqual([
      "0 of 1 line",
      "1 scene",
      "1 speech found",
    ]);
    expect(describeProgress({ stage: "labelling", pages: null }, "en-US")).toEqual({ stage: 1, fraction: null, counts: [] });
  });

  it("falls back to parts when lines are unknown, and clamps", () => {
    expect(describeProgress({ stage: "labelling", chunksDone: 1, chunksTotal: 4 }).fraction).toBe(0.25);
    expect(describeProgress({ stage: "labelling", linesDone: 900, linesTotal: 500 }).fraction).toBe(1);
  });

  it("fills the bar while saving", () => {
    const view = describeProgress({ stage: "saving", linesDone: 5190, linesTotal: 5190, scenes: 20 }, "en-US");
    expect(view).toEqual({ stage: 2, fraction: 1, counts: ["5,190 lines", "20 scenes"] });
  });
});

describe("bar pacing", () => {
  it("creeps ahead of real progress by elapsed time, within limits", async () => {
    const { displayFraction, estimateLabelMs } = await import("./parseProgress");
    expect(displayFraction(0, 5_000, 20_000)).toBeCloseTo(0.12);
    expect(displayFraction(0.5, 5_000, 20_000)).toBe(0.5);
    expect(displayFraction(0.5, 15_000, 20_000)).toBeCloseTo(0.62);
    expect(displayFraction(0.9, 60_000, 20_000)).toBeCloseTo(0.95);
    expect(displayFraction(1, 0, 20_000)).toBe(1);
    expect(estimateLabelMs(5000)).toBe(35_000);
  });
});
