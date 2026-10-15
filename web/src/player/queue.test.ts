import { describe, expect, it } from "vitest";
import {
  abBounds,
  gapBetweenMs,
  LINE_GAP_MS,
  nextIndex,
  placeholderMs,
  prefetchWindow,
  previousIndex,
  SECTION_GAP_MS,
  stepFor,
  type QueueLine,
} from "./queue";
import { silenceWav } from "./silence";

// Scene 1: a, b, c. Scene 2: d, e, f.
const lines: QueueLine[] = ["a", "b", "c", "d", "e", "f"].map((id, i) => ({
  lineId: id,
  sectionId: i < 3 ? "s1" : "s2",
  text: id === "b" ? "one two three four five six seven eight nine ten" : "Yes.",
}));
const noAb = { a: null, b: null };

describe("next line and gaps", () => {
  it("walks the play in order and stops at the end", () => {
    expect(nextIndex(lines, 0, noAb)).toBe(1);
    expect(nextIndex(lines, 4, noAb)).toBe(5);
    expect(nextIndex(lines, 5, noAb)).toBeNull();
  });

  it("pauses briefly within a scene and longer at a scene change", () => {
    expect(gapBetweenMs(lines, 0, 1)).toBe(LINE_GAP_MS);
    expect(gapBetweenMs(lines, 2, 3)).toBe(SECTION_GAP_MS);
  });

  it("previous restarts a line that has played a while, else goes back one", () => {
    expect(previousIndex(3, 2000)).toBe(3);
    expect(previousIndex(3, 200)).toBe(2);
    expect(previousIndex(0, 200)).toBe(0);
    expect(previousIndex(-1, 0)).toBe(0);
  });

  it("silent lines last as long as the render's placeholder", () => {
    expect(placeholderMs("Yes.")).toBe(1200);
    expect(placeholderMs("one two three four five six seven eight nine ten")).toBe(3800);
    expect(placeholderMs("word ".repeat(100))).toBe(8000);
  });
});

describe("A–B repeat", () => {
  it("needs both ends, in either tap order", () => {
    expect(abBounds({ a: 3, b: null })).toBeNull();
    expect(abBounds({ a: 4, b: 1 })).toEqual({ first: 1, last: 4 });
  });

  it("loops from B back to A, with a scene-change pause", () => {
    const ab = { a: 3, b: 1 };
    expect(nextIndex(lines, 1, ab)).toBe(2);
    expect(nextIndex(lines, 3, ab)).toBe(1);
    expect(gapBetweenMs(lines, 3, 1)).toBe(SECTION_GAP_MS);
  });

  it("a one-line range repeats that line", () => {
    expect(nextIndex(lines, 2, { a: 2, b: 2 })).toBe(2);
  });
});

describe("my part", () => {
  const mine = new Set(["b", "e"]);

  it("holds a speaking gap on the actor's own lines, scaled by their setting", () => {
    expect(stepFor(lines, 0, mine, 1)).toEqual({ kind: "line", index: 0 });
    expect(stepFor(lines, 1, mine, 1)).toEqual({ kind: "speak", index: 1, durationMs: 4800 });
    expect(stepFor(lines, 1, mine, 1.5)).toEqual({ kind: "speak", index: 1, durationMs: 7200 });
    expect(stepFor(lines, 1, null, 1)).toEqual({ kind: "line", index: 1 });
  });
});

describe("prefetch window", () => {
  it("starts at the current line and looks ahead in order", () => {
    expect(prefetchWindow(lines, 0, 3, null, noAb)).toEqual(["a", "b", "c"]);
    expect(prefetchWindow(lines, 4, 5, null, noAb)).toEqual(["e", "f"]);
    expect(prefetchWindow(lines, -1, 1, null, noAb)).toEqual(["a"]);
  });

  it("skips the actor's own lines in my-part mode", () => {
    expect(prefetchWindow(lines, 0, 4, new Set(["b", "e"]), noAb)).toEqual(["a", "c", "d", "f"]);
  });

  it("follows an A–B loop and lists each line once", () => {
    expect(prefetchWindow(lines, 2, 10, null, { a: 1, b: 3 })).toEqual(["c", "d", "b"]);
    expect(prefetchWindow(lines, 1, 10, new Set(["c"]), { a: 1, b: 3 })).toEqual(["b", "d"]);
  });
});

describe("silence", () => {
  it("is a valid mono 16-bit WAV of the asked length", () => {
    const wav = silenceWav(250);
    const view = new DataView(wav.buffer);
    expect(String.fromCharCode(...wav.slice(0, 4))).toBe("RIFF");
    expect(view.getUint32(40, true)).toBe(2 * 2000);
    expect(wav.length).toBe(44 + 4000);
  });
});
