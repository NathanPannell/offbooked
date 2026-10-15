import { describe, expect, it } from "vitest";
import {
  gapBetweenMs,
  LINE_GAP_MS,
  nextIndex,
  NO_PART,
  placeholderMs,
  playableFrom,
  prefetchWindow,
  previousIndex,
  SECTION_GAP_MS,
  stepFor,
  type Part,
  type QueueLine,
} from "./queue";
import { silenceWav } from "./silence";

// Scene 1: a, b, c. Scene 2: d, e, f.
const lines: QueueLine[] = ["a", "b", "c", "d", "e", "f"].map((id, i) => ({
  lineId: id,
  sectionId: i < 3 ? "s1" : "s2",
  text: id === "b" ? "one two three four five six seven eight nine ten" : "Yes.",
}));
const part = (mode: Part["mode"], ids = ["b", "e"]): Part => ({ mine: new Set(ids), mode });

describe("next line and gaps", () => {
  it("walks the play in order, across scenes, and stops at the end", () => {
    expect(nextIndex(lines, 0)).toBe(1);
    expect(nextIndex(lines, 2)).toBe(3);
    expect(nextIndex(lines, 4)).toBe(5);
    expect(nextIndex(lines, 5)).toBeNull();
  });

  it("pauses briefly within a scene and longer at a scene change", () => {
    expect(gapBetweenMs(lines, 0, 1)).toBe(LINE_GAP_MS);
    expect(gapBetweenMs(lines, 2, 3)).toBe(SECTION_GAP_MS);
    expect(gapBetweenMs(lines, 0, 2)).toBe(LINE_GAP_MS);
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

describe("my lines", () => {
  it("read: my lines play like anyone's, marked as mine", () => {
    expect(stepFor(lines, 0, part("read"))).toEqual({ kind: "line", index: 0, mine: false });
    expect(stepFor(lines, 1, part("read"))).toEqual({ kind: "line", index: 1, mine: true });
    expect(nextIndex(lines, 0, part("read"))).toBe(1);
  });

  it("skip: my lines are left out, with no gap of their own", () => {
    expect(nextIndex(lines, 0, part("skip"))).toBe(2);
    expect(nextIndex(lines, 3, part("skip"))).toBe(5);
    expect(playableFrom(lines, 1, part("skip"))).toBe(2);
    expect(playableFrom(lines, 5, part("skip", ["f"]))).toBeNull();
    expect(gapBetweenMs(lines, 0, 2)).toBe(LINE_GAP_MS);
  });

  it("pause: a pause timed from my spoken words, or from my take when there is one", () => {
    // Ten words at 2.5 words a second.
    expect(stepFor(lines, 1, part("pause"))).toEqual({ kind: "speak", index: 1, durationMs: 4000 });
    // A 3 s take: plus 15% (450 ms) or 500 ms, whichever is more.
    expect(stepFor(lines, 1, part("pause"), 3000)).toEqual({ kind: "speak", index: 1, durationMs: 3500 });
    expect(stepFor(lines, 0, part("pause"))).toEqual({ kind: "line", index: 0, mine: false });
  });

  it("no role: nothing is mine", () => {
    expect(stepFor(lines, 1, NO_PART)).toEqual({ kind: "line", index: 1, mine: false });
    expect(stepFor(lines, 1, { mine: null, mode: "pause" })).toEqual({ kind: "line", index: 1, mine: false });
  });
});

describe("prefetch window", () => {
  it("starts at the current line and looks ahead in order, across scenes", () => {
    expect(prefetchWindow(lines, 0, 3)).toEqual(["a", "b", "c"]);
    expect(prefetchWindow(lines, 2, 3)).toEqual(["c", "d", "e"]);
    expect(prefetchWindow(lines, 4, 5)).toEqual(["e", "f"]);
    expect(prefetchWindow(lines, -1, 1)).toEqual(["a"]);
  });

  it("leaves out my lines only when they are skipped", () => {
    expect(prefetchWindow(lines, 0, 4, part("skip"))).toEqual(["a", "c", "d", "f"]);
    expect(prefetchWindow(lines, 0, 4, part("pause"))).toEqual(["a", "b", "c", "d"]);
    expect(prefetchWindow(lines, 0, 4, part("read"))).toEqual(["a", "b", "c", "d"]);
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
