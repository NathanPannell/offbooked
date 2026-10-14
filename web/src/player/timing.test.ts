import { describe, expect, it } from "vitest";
import { audioSourceTag, gapMs, wordCount } from "./timing";

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
});

describe("audio source", () => {
  it("tags everything but the cast's own takes", () => {
    expect(audioSourceTag("actor")).toBeNull();
    expect(audioSourceTag("standin")).toBe("stand-in");
    expect(audioSourceTag("tts")).toBe("TTS");
    expect(audioSourceTag("none")).toBe("silent");
  });
});
