import { describe, expect, it } from "vitest";
import {
  abLoopTarget,
  audioSourceOf,
  audioSourceTag,
  abRange,
  buildSegments,
  gapMs,
  myGapSegmentAt,
  nextLineStart,
  previousLineStart,
  segmentIndexAt,
  wordCount,
} from "./timing";

const segments = buildSegments([
  { lineId: "c", startMs: 5000, endMs: 8000, recorded: false },
  { lineId: "a", startMs: 0, endMs: 2000, recorded: true },
  { lineId: "b", startMs: 2350, endMs: 4000, recorded: true },
]);

describe("segmentIndexAt", () => {
  it("sorts by start time", () => {
    expect(segments.map((s) => s.lineId)).toEqual(["a", "b", "c"]);
  });

  it("finds the current line, holding it through the pause after it", () => {
    expect(segmentIndexAt(segments, 0)).toBe(0);
    expect(segmentIndexAt(segments, 2100)).toBe(0);
    expect(segmentIndexAt(segments, 2350)).toBe(1);
    expect(segmentIndexAt(segments, 99_999)).toBe(2);
  });

  it("returns -1 before the first line and for an empty map", () => {
    expect(segmentIndexAt(buildSegments([{ lineId: "x", startMs: 500, endMs: 900, recorded: true }]), 100)).toBe(-1);
    expect(segmentIndexAt([], 100)).toBe(-1);
  });
});

describe("next and previous", () => {
  it("skips to the next line boundary", () => {
    expect(nextLineStart(segments, 100)).toBe(2350);
    expect(nextLineStart(segments, 2350)).toBe(5000);
    expect(nextLineStart(segments, 6000)).toBeNull();
  });

  it("restarts the current line if it has been playing a while", () => {
    expect(previousLineStart(segments, 7000)).toBe(5000);
  });

  it("goes back a line near the start of a line", () => {
    expect(previousLineStart(segments, 5200)).toBe(2350);
    expect(previousLineStart(segments, 300)).toBe(0);
    expect(previousLineStart([], 300)).toBe(0);
  });
});

describe("A–B repeat", () => {
  it("covers whole lines in either tap order", () => {
    expect(abRange(segments, 2, 0)).toEqual({ startMs: 0, endMs: 8000 });
    expect(abRange(segments, 1, 1)).toEqual({ startMs: 2350, endMs: 4000 });
  });

  it("loops back at the end of B", () => {
    const range = abRange(segments, 0, 1);
    expect(abLoopTarget(range, 3999)).toBeNull();
    expect(abLoopTarget(range, 4000)).toBe(0);
  });
});

describe("my part gaps", () => {
  it("counts words, ignoring punctuation", () => {
    expect(wordCount("Hail to your lordship — sir!")).toBe(5);
  });

  it("plans a gap from the line length, scaled and clamped", () => {
    expect(gapMs("Yes.", 1)).toBe(1500);
    expect(gapMs("one two three four five six seven eight nine ten", 1)).toBe(4800);
    expect(gapMs("one two three four five six seven eight nine ten", 1.5)).toBe(7200);
    expect(gapMs("one two three four five six seven eight nine ten", 9)).toBe(9600);
    expect(gapMs("word ".repeat(100), 1)).toBe(15_000);
  });

  it("stops on the actor's own line, slightly early", () => {
    const mine = new Set(["b"]);
    expect(myGapSegmentAt(segments, mine, 2000)).toBeNull();
    expect(myGapSegmentAt(segments, mine, 2320)?.lineId).toBe("b");
    expect(myGapSegmentAt(segments, mine, 3000)?.lineId).toBe("b");
  });

  it("doesn't stop again once playback resumes at the line's end", () => {
    const mine = new Set(["b"]);
    expect(myGapSegmentAt(segments, mine, 4000)).toBeNull();
    expect(myGapSegmentAt(segments, mine, 5000)).toBeNull();
  });
});

describe("audio source", () => {
  it("uses the server's source, or derives it from recorded", () => {
    expect(audioSourceOf({ recorded: true, source: "standin" })).toBe("standin");
    expect(audioSourceOf({ recorded: false, source: "tts" })).toBe("tts");
    expect(audioSourceOf({ recorded: true })).toBe("actor");
    expect(audioSourceOf({ recorded: false })).toBe("none");
    expect(audioSourceOf(undefined)).toBe("none");
  });

  it("tags everything but the cast's own takes", () => {
    expect(audioSourceTag("actor")).toBeNull();
    expect(audioSourceTag("standin")).toBe("stand-in");
    expect(audioSourceTag("tts")).toBe("TTS");
    expect(audioSourceTag("none")).toBe("silent");
  });
});
