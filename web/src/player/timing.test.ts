import { describe, expect, it } from "vitest";
import { audioSourceTag, MIN_PAUSE_MS, myLinePauseMs, spokenText, wordCount } from "./timing";

describe("my-line pauses", () => {
  it("counts words, ignoring punctuation", () => {
    expect(wordCount("Hail to your lordship — sir!")).toBe(5);
  });

  it("times an unrecorded line at a stage rate of 150 words a minute", () => {
    expect(myLinePauseMs({ text: "one two three four five six seven eight nine ten" })).toBe(4000);
    expect(myLinePauseMs({ text: "word ".repeat(150) })).toBe(60_000);
  });

  it("counts only spoken words: bracketed directions are left out", () => {
    expect(spokenText("Now go. [To the Servant.] Was it not")).not.toContain("Servant");
    expect(myLinePauseMs({ text: "Now go. [To the Servant.] Was it not so" })).toBe(myLinePauseMs({ text: "Now go. Was it not so" }));
    expect(myLinePauseMs({ text: "[Aside.] Five words are spoken here" })).toBe(2000);
  });

  it("never pauses for less than a second", () => {
    expect(myLinePauseMs({ text: "Yes." })).toBe(MIN_PAUSE_MS);
    expect(myLinePauseMs({ text: "[Exit.]" })).toBe(MIN_PAUSE_MS);
    expect(myLinePauseMs({ text: "Ay.", recordedMs: 300 })).toBe(MIN_PAUSE_MS);
  });

  it("times a recorded line from its take, plus 15% or half a second, whichever is more", () => {
    expect(myLinePauseMs({ text: "anything", recordedMs: 2000 })).toBe(2500);
    expect(myLinePauseMs({ text: "anything", recordedMs: 10_000 })).toBe(11_500);
    expect(myLinePauseMs({ text: "anything", recordedMs: 0 })).toBe(MIN_PAUSE_MS);
  });
});

describe("audio source", () => {
  it("tags everything but recordings", () => {
    expect(audioSourceTag("actor")).toBeNull();
    expect(audioSourceTag("director")).toBeNull();
    expect(audioSourceTag("tts")).toBe("TTS");
    expect(audioSourceTag("none")).toBe("silent");
  });
});
