import { describe, expect, it } from "vitest";
import { myLineNumber, myStops, nextMine, previousMine } from "./myLines";
import type { QueueLine } from "./queue";

// Scene 1: a, M1, b, c, d, M2. Scene 2 (not in it): e, f, g. Scene 3: M3 opens it, a direction,
// M4 straight after M3, h, a direction, M5.
const plan: [string, string, QueueLine["kind"]?][] = [
  ["a", "s1"],
  ["M1", "s1"],
  ["b", "s1"],
  ["c", "s1"],
  ["d", "s1"],
  ["M2", "s1"],
  ["e", "s2"],
  ["f", "s2"],
  ["g", "s2"],
  ["M3", "s3"],
  ["dir1", "s3", "stage_direction"],
  ["M4", "s3"],
  ["h", "s3"],
  ["dir2", "s3", "stage_direction"],
  ["M5", "s3"],
];
const queue: QueueLine[] = plan.map(([lineId, sectionId, kind]) => ({ lineId, sectionId, text: lineId, kind: kind ?? "dialogue" }));
const mine = new Set(["M1", "M2", "M3", "M4", "M5"]);
const stops = myStops(queue, mine);

describe("my lines and where a jump lands", () => {
  it("lands on each line's cue: the dialogue line before it, in its scene and not mine", () => {
    expect(stops).toEqual([
      { line: 1, land: 0 },
      { line: 5, land: 4 },
      // Opens its scene: the line before is in another scene, so no cue.
      { line: 9, land: 9 },
      // Straight after one of mine (the direction between doesn't count): no cue.
      { line: 11, land: 11 },
      // A direction between the cue and the line is passed over.
      { line: 14, land: 12 },
    ]);
  });

  it("has nothing without lines of mine", () => {
    expect(myStops(queue, new Set())).toEqual([]);
    expect(nextMine([], -1)).toBeNull();
    expect(previousMine([], 5)).toBeNull();
    expect(myLineNumber([], 5)).toBe(0);
  });

  it("never treats a stage direction as mine or as a cue", () => {
    expect(myStops(queue, new Set(["dir1"]))).toEqual([]);
  });
});

describe("My next line", () => {
  it("goes to the first one before anything has played", () => {
    expect(nextMine(stops, -1)).toBe(0);
  });

  it("skips a run of other people's lines to the next cue", () => {
    expect(nextMine(stops, 1)).toBe(4);
    expect(nextMine(stops, 2)).toBe(4);
  });

  it("from a cue, or the line it cues, goes on to the one after", () => {
    expect(nextMine(stops, 4)).toBe(9);
    expect(nextMine(stops, 5)).toBe(9);
  });

  it("skips a whole scene I'm not in", () => {
    expect(nextMine(stops, 6)).toBe(9);
  });

  it("goes line to line when mine follow each other", () => {
    expect(nextMine(stops, 9)).toBe(11);
    expect(nextMine(stops, 10)).toBe(11);
    expect(nextMine(stops, 11)).toBe(12);
  });

  it("has nowhere to go after the last one", () => {
    expect(nextMine(stops, 12)).toBeNull();
    expect(nextMine(stops, 14)).toBeNull();
  });
});

describe("My previous line", () => {
  it("from a line or its cue, goes to the one before it, not back to its own cue", () => {
    expect(previousMine(stops, 5)).toBe(0);
    expect(previousMine(stops, 4)).toBe(0);
    expect(previousMine(stops, 14)).toBe(11);
    expect(previousMine(stops, 13)).toBe(11);
  });

  it("from other people's lines, goes back to the last one of mine", () => {
    expect(previousMine(stops, 3)).toBe(0);
    expect(previousMine(stops, 7)).toBe(4);
    expect(previousMine(stops, 10)).toBe(9);
  });

  it("has nowhere to go before the first", () => {
    expect(previousMine(stops, -1)).toBeNull();
    expect(previousMine(stops, 0)).toBeNull();
    expect(previousMine(stops, 1)).toBeNull();
  });

  it("undoes My next line", () => {
    for (let i = -1; i < queue.length; i++) {
      const next = nextMine(stops, i);
      if (next !== null && next > 0) expect(nextMine(stops, previousMine(stops, next) ?? -1)).toBe(next);
    }
  });
});

describe("which of my lines", () => {
  it("counts a line as reached from its cue", () => {
    expect(myLineNumber(stops, -1)).toBe(0);
    expect(myLineNumber(stops, 0)).toBe(1);
    expect(myLineNumber(stops, 3)).toBe(1);
    expect(myLineNumber(stops, 4)).toBe(2);
    expect(myLineNumber(stops, 8)).toBe(2);
    expect(myLineNumber(stops, 12)).toBe(5);
    expect(myLineNumber(stops, 14)).toBe(5);
  });
});
