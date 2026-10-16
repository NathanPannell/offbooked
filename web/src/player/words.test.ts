import { describe, expect, it } from "vitest";
import { lineTokens, wordAt, wordTimes, type WordToken } from "./words";

const words = (text: string, tokens: WordToken[]) => tokens.map((t) => text.slice(t.start, t.end));
const said = (tokens: WordToken[]) => tokens.flatMap((t) => t.pieces);

describe("lineTokens", () => {
  it("splits a line into printed words with their offsets", () => {
    const text = "Is this a dagger\nwhich I see?";
    const tokens = lineTokens(text);
    expect(words(text, tokens)).toEqual(["Is", "this", "a", "dagger", "which", "I", "see?"]);
    expect(tokens.map((t) => t.line)).toEqual([0, 0, 0, 0, 1, 1, 1]);
    expect(tokens.every((t) => !t.narrator)).toBe(true);
  });

  it("marks [bracketed] directions as the narrator's, without their brackets in what is said", () => {
    const text = "Now go. [To the Servant.] Was it not";
    const tokens = lineTokens(text);
    expect(words(text, tokens)).toEqual(["Now", "go.", "[To", "the", "Servant.]", "Was", "it", "not"]);
    expect(tokens.map((t) => t.narrator)).toEqual([false, false, true, true, true, false, false, false]);
    expect(said(tokens)).toEqual(["Now", "go.", "To", "the", "Servant.", "Was", "it", "not"]);
  });

  it("splits a direction glued to a word", () => {
    const text = "Away![Exit.]";
    const tokens = lineTokens(text);
    expect(words(text, tokens)).toEqual(["Away!", "[Exit.]"]);
    expect(tokens.map((t) => t.narrator)).toEqual([false, true]);
  });

  it("runs an unclosed bracket to the end of its printed line", () => {
    const text = "Stay [aside\nand hear";
    const tokens = lineTokens(text);
    expect(tokens.map((t) => t.narrator)).toEqual([false, true, false, false]);
  });

  it("leaves {notes} and wordless lines unsaid", () => {
    const text = "Go {beat} now\n—";
    const tokens = lineTokens(text);
    expect(words(text, tokens)).toEqual(["Go", "{beat}", "now", "—"]);
    expect(tokens.map((t) => t.pieces.length)).toEqual([1, 0, 1, 0]);
  });

  it("reads a stage direction whole, by the narrator, without parentheses", () => {
    const text = "(Enter MACBETH.)";
    const tokens = lineTokens(text, "stage_direction");
    expect(tokens.every((t) => t.narrator)).toBe(true);
    expect(said(tokens)).toEqual(["Enter", "MACBETH."]);
  });

  it("drops markup the voice doesn't say", () => {
    expect(said(lineTokens("I *will* go _now_"))).toEqual(["I", "will", "go", "now"]);
  });
});

describe("wordTimes", () => {
  it("places each segment's words inside that segment, with the gap between as a pause", () => {
    const text = "To be, or not\nto be.";
    const tokens = lineTokens(text);
    const times = wordTimes(tokens, {
      durationMs: 3000,
      segments: [
        { startMs: 0, endMs: 1200, text: "To be, or not", narrator: false },
        { startMs: 1600, endMs: 2800, text: "to be.", narrator: false },
      ],
    });
    expect(times).toHaveLength(6);
    for (const t of times.slice(0, 4)) {
      expect(t.startMs).toBeGreaterThanOrEqual(0);
      expect(t.endMs).toBeLessThanOrEqual(1200);
    }
    for (const t of times.slice(4)) {
      expect(t.startMs).toBeGreaterThanOrEqual(1600);
      expect(t.endMs).toBeLessThanOrEqual(2800);
    }
    // In order, and a word never ends before it starts.
    for (let i = 0; i < times.length; i++) {
      expect(times[i]!.endMs).toBeGreaterThan(times[i]!.startMs);
      if (i > 0) expect(times[i]!.startMs).toBeGreaterThanOrEqual(times[i - 1]!.endMs);
    }
    expect(wordAt(times, 1400)).toBe(3); // the pause between the lines: "not" stays current
    expect(wordAt(times, 1600)).toBe(4);
  });

  it("gives longer words more time, and a comma a pause", () => {
    const tokens = lineTokens("Extraordinarily, so");
    const [a, b] = wordTimes(tokens, { durationMs: 2000 });
    expect(a!.endMs - a!.startMs).toBeGreaterThan(b!.endMs - b!.startMs);
    expect(b!.startMs).toBeGreaterThan(a!.endMs);
  });

  it("maps narrator segments onto the bracketed words", () => {
    const text = "Now go. [To the Servant.] Was it not";
    const times = wordTimes(lineTokens(text), {
      durationMs: 5000,
      segments: [
        { startMs: 0, endMs: 900, text: "Now go.", narrator: false },
        { startMs: 1200, endMs: 2400, text: "To the Servant.", narrator: true },
        { startMs: 2800, endMs: 4000, text: "Was it not", narrator: false },
      ],
    });
    expect(times[2]!.startMs).toBeGreaterThanOrEqual(1200);
    expect(times[4]!.endMs).toBeLessThanOrEqual(2400);
    expect(times[5]!.startMs).toBeGreaterThanOrEqual(2800);
  });

  it("spreads a take's whole length over its words, after a short lead-in", () => {
    const times = wordTimes(lineTokens("Out, damned spot! Out, I say!"), { durationMs: 2400 });
    expect(times[0]!.startMs).toBeGreaterThan(0);
    expect(times[0]!.startMs).toBeLessThan(150);
    expect(times[times.length - 1]!.endMs).toBeLessThan(2400);
    expect(times[times.length - 1]!.endMs).toBeGreaterThan(2000);
  });

  it("falls back to the spoken span when the segments don't match the words", () => {
    const times = wordTimes(lineTokens("Something else entirely here"), {
      durationMs: 3000,
      segments: [{ startMs: 500, endMs: 2500, text: "Original words", narrator: false }],
    });
    expect(times[0]!.startMs).toBe(500);
    expect(times[3]!.endMs).toBeLessThanOrEqual(2500);
  });

  it("never makes an unsaid word current", () => {
    const tokens = lineTokens("Go {beat} now");
    const times = wordTimes(tokens, { durationMs: 1500 });
    expect(times[1]!.spoken).toBe(false);
    for (let ms = 0; ms <= 1500; ms += 50) expect(wordAt(times, ms)).not.toBe(1);
    expect(wordAt(times, 1500)).toBe(2);
  });

  it("scales with the clip, so it holds at any playback speed (media time)", () => {
    const tokens = lineTokens("one two three four");
    const times = wordTimes(tokens, { durationMs: 2000 });
    expect(wordAt(times, -1)).toBe(-1);
    expect(wordAt(times, 0)).toBe(-1);
    expect(wordAt(times, 1999)).toBe(3);
  });

  it("handles an empty line", () => {
    expect(wordTimes(lineTokens(""), { durationMs: 1000 })).toEqual([]);
    expect(wordAt([], 500)).toBe(-1);
  });
});
