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
