import { describe, expect, it } from "vitest";
import { cueRange, lineTokens, TAIL_MS, wordAt, wordTimes, type WordToken } from "./words";

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

describe("wordTimes for a recorded take", () => {
  const text = "Out, damned spot!\nOut, I say!";
  const tokens = lineTokens(text);

  it("uses the take's real word starts when there is one per spoken word", () => {
    const starts = [100, 450, 900, 1800, 2100, 2300];
    const times = wordTimes(tokens, {
      durationMs: 3000,
      wordStartsMs: starts,
      speech: [
        { startMs: 80, endMs: 1400 },
        { startMs: 1750, endMs: 2700 },
      ],
    });
    expect(times.map((t) => t.startMs)).toEqual(starts);
    // Each word runs to the next one's start, or to the end of its stretch of speech.
    expect(times[0]!.endMs).toBe(450);
    expect(times[2]!.endMs).toBe(1400); // "spot!" ends with its stretch, not at the next word
    expect(times[5]!.endMs).toBe(2700);
    expect(wordAt(times, 1600)).toBe(2);
    expect(wordAt(times, 1800)).toBe(3);
  });

  it("ends the last word at the clip's end less the tail without speech stretches", () => {
    const times = wordTimes(tokens, { durationMs: 3000, wordStartsMs: [100, 450, 900, 1800, 2100, 2300] });
    expect(times[2]!.endMs).toBe(1800);
    expect(times[5]!.endMs).toBe(3000 - TAIL_MS);
  });

  it("never runs a word backwards when the starts are out of order", () => {
    const times = wordTimes(lineTokens("one two three"), { durationMs: 2000, wordStartsMs: [500, 300, 900] });
    for (let i = 0; i < times.length; i++) {
      expect(times[i]!.endMs).toBeGreaterThanOrEqual(times[i]!.startMs);
      if (i > 0) expect(times[i]!.startMs).toBeGreaterThanOrEqual(times[i - 1]!.startMs);
    }
  });

  it("ignores word starts that don't match the words, and spreads them over the speech instead", () => {
    const speech = [
      { startMs: 100, endMs: 1300 },
      { startMs: 2000, endMs: 3000 },
    ];
    const times = wordTimes(tokens, { durationMs: 3200, wordStartsMs: [100, 400], speech });
    // No word starts or ends inside the pause.
    for (const t of times) expect(t.startMs >= 1300 && t.startMs < 2000).toBe(false);
    for (const t of times) expect(t.endMs > 1300 && t.endMs <= 2000).toBe(false);
    // The first sentence in the first stretch, the second in the second.
    expect(times[0]!.startMs).toBe(100);
    expect(times[2]!.endMs).toBeLessThanOrEqual(1300);
    expect(times[3]!.startMs).toBe(2000);
    expect(times[5]!.endMs).toBeCloseTo(3000, 5);
    expect(wordAt(times, 1700)).toBe(2); // the pause: "spot!" stays current
  });

  it("keeps the weighting within a stretch", () => {
    const [a, b] = wordTimes(lineTokens("Extraordinarily, so"), { durationMs: 2500, speech: [{ startMs: 200, endMs: 2200 }] });
    expect(a!.startMs).toBe(200);
    expect(a!.endMs - a!.startMs).toBeGreaterThan(b!.endMs - b!.startMs);
    expect(b!.startMs).toBeGreaterThan(a!.endMs);
    expect(b!.endMs).toBeCloseTo(2200, 5);
  });

  it("falls back to the whole take without word starts or speech", () => {
    const times = wordTimes(tokens, { durationMs: 4000, wordStartsMs: [], speech: [] });
    expect(times[0]!.startMs).toBeGreaterThan(0);
    expect(times[5]!.endMs).toBeCloseTo(4000 - TAIL_MS, 5);
  });
});

describe("cueRange", () => {
  const cue = (text: string) => {
    const r = cueRange(text);
    return r ? text.slice(r.start, r.end) : null;
  };

  it("is the line's last sentence", () => {
    expect(cue("Who's there? Nay, answer me. Stand and unfold yourself.")).toBe("Stand and unfold yourself.");
    expect(cue("Long live the king!")).toBe("Long live the king!");
  });

  it("runs across printed lines of verse", () => {
    expect(cue("Tis now struck twelve.\nGet thee to bed,\nFrancisco.")).toBe("Get thee to bed,\nFrancisco.");
  });

  it("leaves out a direction at the end, and starts after one in the middle", () => {
    expect(cue("Give me some light. Away! [Exit.]")).toBe("Away!");
    expect(cue("Now go. [To the Servant.] Was it not")).toBe("Was it not");
  });

  it("keeps a closing quote with its sentence", () => {
    expect(cue('He said "Go." Then he went')).toBe("Then he went");
  });

  it("is null for a line with no words", () => {
    expect(cueRange("")).toBeNull();
    expect(cueRange("[Exit.]")).toBeNull();
  });
});
