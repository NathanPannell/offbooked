import { describe, expect, it } from "vitest";
import { needsTrack, REFRESH_LINES, trackWindow } from "./listenTrack";
import { NO_PART, sameLines, samePart, type QueueLine } from "./queue";

const queue: QueueLine[] = Array.from({ length: 10 }, (_, i) => ({ lineId: `l${i}`, sectionId: i < 5 ? "s1" : "s2", text: "Some words." }));

describe("the stretch asked for", () => {
  it("runs from the current line in playback order, up to the most a track holds", () => {
    expect(trackWindow(queue, 3, NO_PART, 4)).toEqual({ lineIds: ["l3", "l4", "l5", "l6"], mine: [], mode: "read" });
    expect(trackWindow(queue, 8, NO_PART).lineIds).toEqual(["l8", "l9"]);
  });

  it("names the listener's lines in it and their mode; with none in it the mode doesn't matter", () => {
    const part = { mine: new Set(["l4", "l9"]), mode: "pause" as const };
    expect(trackWindow(queue, 2, part, 4)).toEqual({ lineIds: ["l2", "l3", "l4", "l5"], mine: ["l4"], mode: "pause" });
    // So the same stretch heard by someone with no lines in it is the same track.
    expect(trackWindow(queue, 5, part, 4)).toEqual({ lineIds: ["l5", "l6", "l7", "l8"], mine: [], mode: "read" });
  });
});

describe("when to ask", () => {
  it("asks when no track covers the line, or the one that does ends soon (unless it runs to the end)", () => {
    expect(needsTrack(null, 0, 500)).toBe(true);
    expect(needsTrack(299, 0, 500)).toBe(false);
    expect(needsTrack(299, 299 - REFRESH_LINES + 1, 500)).toBe(true);
    expect(needsTrack(499, 480, 500)).toBe(false);
  });
});

describe("what a track still fits", () => {
  it("the same lines in the same order, however often the script is reloaded", () => {
    expect(
      sameLines(
        queue,
        queue.map((l) => ({ ...l })),
      ),
    ).toBe(true);
    expect(sameLines(queue, queue.slice(1))).toBe(false);
    expect(sameLines(queue, [...queue].reverse())).toBe(false);
  });

  it("the same lines of mine and the same mode on them; the mode doesn't matter with none", () => {
    expect(samePart({ mine: new Set(["a", "b"]), mode: "pause" }, { mine: new Set(["b", "a"]), mode: "pause" })).toBe(true);
    expect(samePart({ mine: new Set(["a"]), mode: "pause" }, { mine: new Set(["a"]), mode: "skip" })).toBe(false);
    expect(samePart({ mine: new Set(["a"]), mode: "pause" }, { mine: new Set(["b"]), mode: "pause" })).toBe(false);
    expect(samePart(NO_PART, { mine: new Set(), mode: "pause" })).toBe(true);
    expect(samePart(NO_PART, { mine: new Set(["a"]), mode: "read" })).toBe(false);
  });
});
