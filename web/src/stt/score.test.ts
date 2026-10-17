import { describe, expect, it } from "vitest";
import {
  accuracyFromOps,
  alignWords,
  annotateLine,
  cleanTranscript,
  isNearMatch,
  noSpeechResult,
  normalizeWords,
  formatVerdictCounts,
  numberToWords,
  overallAccuracy,
  scoreLabel,
  scoreLine,
  verdict,
  verdictCounts,
} from "./score";

describe("normalizeWords", () => {
  it("lowercases and strips punctuation", () => {
    expect(normalizeWords("To be, or not to be: that is the question!")).toEqual(
      "to be or not to be that is the question".split(" "),
    );
  });

  it("treats curly and straight apostrophes the same", () => {
    expect(normalizeWords("I’ll go")).toEqual(normalizeWords("I'll go"));
  });

  it("expands contractions so they match the long form", () => {
    expect(normalizeWords("I'll")).toEqual(["i", "will"]);
    expect(normalizeWords("I will")).toEqual(["i", "will"]);
    expect(normalizeWords("don't won't can't")).toEqual(["do", "not", "will", "not", "can", "not"]);
    expect(normalizeWords("cannot")).toEqual(["can", "not"]);
    expect(normalizeWords("it's what's")).toEqual(["it", "is", "what", "is"]);
    expect(normalizeWords("'Tis")).toEqual(["it", "is"]);
  });

  it("expands archaic contractions", () => {
    expect(normalizeWords("O'er the hills, ne'er again")).toEqual(["over", "the", "hills", "never", "again"]);
  });

  it("drops possessive apostrophes", () => {
    expect(normalizeWords("Hamlet's father")).toEqual(["hamlets", "father"]);
  });

  it("splits on dashes and ellipses", () => {
    expect(normalizeWords("My good lord—wait… well-known")).toEqual([
      "my", "good", "lord", "wait", "well", "known",
    ]);
  });

  it("spells out simple numbers", () => {
    expect(normalizeWords("I have 3 sons and 21 daughters")).toEqual(
      "i have three sons and twenty one daughters".split(" "),
    );
  });

  it("strips surrounding quotes but keeps archaic words", () => {
    expect(normalizeWords("“'Hello,' quoth he”")).toEqual(["hello", "quoth", "he"]);
  });

  it("reads ordinals, years and symbols", () => {
    expect(normalizeWords("the 1st of May, 1984")).toEqual("the first of may nineteen eighty four".split(" "));
    expect(normalizeWords("the 22nd")).toEqual(["the", "twenty", "second"]);
    expect(normalizeWords("you & me, 100%")).toEqual("you and me one hundred percent".split(" "));
  });
});

describe("numberToWords", () => {
  it("handles the common ranges", () => {
    expect(numberToWords(0)).toBe("zero");
    expect(numberToWords(15)).toBe("fifteen");
    expect(numberToWords(40)).toBe("forty");
    expect(numberToWords(101)).toBe("one hundred one");
    expect(numberToWords(2024)).toBe("two thousand twenty four");
    expect(numberToWords(5_000_000)).toBe("5000000");
  });
});

describe("cleanTranscript", () => {
  it("removes non-speech markers", () => {
    expect(cleanTranscript(" [BLANK_AUDIO] Hello (laughs) there *sighs* ")).toBe("Hello there");
  });

  it("collapses a looping tail", () => {
    expect(cleanTranscript("Good night, my lord my lord my lord my lord")).toBe("Good night, my lord");
    expect(cleanTranscript("no no no")).toBe("no");
    expect(cleanTranscript("no no")).toBe("no no");
  });
});

describe("alignWords", () => {
  it("marks a perfect match as ok", () => {
    const ops = alignWords(["a", "b"], ["a", "b"]);
    expect(ops.map((o) => o.op)).toEqual(["ok", "ok"]);
  });

  it("finds substitutions, deletions and insertions", () => {
    const ops = alignWords(["the", "quick", "brown", "fox"], ["the", "quack", "fox", "jumps"]);
    expect(ops).toEqual([
      { op: "ok", expected: "the", heard: "the" },
      { op: "sub", expected: "quick", heard: "quack" },
      { op: "del", expected: "brown" },
      { op: "ok", expected: "fox", heard: "fox" },
      { op: "ins", heard: "jumps" },
    ]);
  });

  it("accepts near matches on long words only", () => {
    expect(isNearMatch("petruchio", "petrucio")).toBe(true);
    expect(isNearMatch("theatre", "theater")).toBe(true);
    expect(isNearMatch("bear", "bead")).toBe(false);
    const ops = alignWords(["good", "petruchio"], ["good", "petrucio"]);
    expect(ops.map((o) => o.op)).toEqual(["ok", "ok"]);
  });

  it("merges compounds both ways", () => {
    expect(alignWords(["to", "morrow"], ["tomorrow"])).toEqual([
      { op: "ok", expected: "to", heard: "tomorrow" },
      { op: "ok", expected: "morrow", heard: "tomorrow" },
    ]);
    expect(alignWords(["anyone", "here"], ["any", "one", "here"])).toEqual([
      { op: "ok", expected: "anyone", heard: "any one" },
      { op: "ok", expected: "here", heard: "here" },
    ]);
  });

  it("handles empty sides", () => {
    expect(alignWords([], ["x"])).toEqual([{ op: "ins", heard: "x" }]);
    expect(alignWords(["x"], [])).toEqual([{ op: "del", expected: "x" }]);
    expect(alignWords([], [])).toEqual([]);
  });
});

describe("accuracy", () => {
  it("is 1 - errors / expected words, floored at 0", () => {
    const ops = alignWords(["a", "b", "c", "d"], ["a", "x", "c"]);
    expect(accuracyFromOps(ops)).toBeCloseTo(0.5);
    expect(accuracyFromOps(alignWords(["a"], ["x", "y", "z"]))).toBe(0);
  });

  it("treats an empty line as perfect only when nothing extra was said", () => {
    expect(accuracyFromOps([])).toBe(1);
    expect(accuracyFromOps([{ op: "ins", heard: "um" }])).toBe(0);
  });

  it("scores a contraction-only difference as spot on", () => {
    const result = scoreLine("I will not go, my lord.", "I won't go my lord");
    expect(result.accuracy).toBe(1);
    expect(verdict(result)).toBe("complete");
  });

  it("ignores fillers unless the line has them", () => {
    expect(scoreLine("I am here today", "um I am uh here today").accuracy).toBe(1);
    expect(scoreLine("Um, what?", "um what").accuracy).toBe(1);
  });

  const ops = (ok: number, sub: number, del: number, ins = 0) => [
    ...Array.from({ length: ok }, () => ({ op: "ok" as const, expected: "a", heard: "a" })),
    ...Array.from({ length: sub }, () => ({ op: "sub" as const, expected: "b", heard: "x" })),
    ...Array.from({ length: del }, () => ({ op: "del" as const, expected: "c" })),
    ...Array.from({ length: ins }, () => ({ op: "ins" as const, heard: "y" })),
  ];
  const take = (o: ReturnType<typeof ops>) => ({ transcript: "heard", ops: o });

  it("counts misheard words as said: a line read through is complete", () => {
    expect(verdict(take(ops(10, 0, 0)))).toBe("complete");
    expect(verdict(take(ops(4, 6, 0)))).toBe("complete");
    expect(verdict(take(ops(5, 2, 3)))).toBe("complete");
    expect(verdict(take(ops(7, 0, 3, 4)))).toBe("complete");
    expect(verdict(scoreLine("Get thee to a nunnery, go, farewell.", "get the to a bakery go farewell"))).toBe("complete");
  });

  it("calls a line partial when a real chunk is missing", () => {
    expect(verdict(take(ops(6, 0, 4)))).toBe("partial");
    expect(verdict(take(ops(1, 0, 9)))).toBe("partial");
    expect(verdict(scoreLine("To be, or not to be, that is the question.", "to be or not to be"))).toBe("partial");
  });

  it("calls a line not attempted when nothing of it was heard", () => {
    expect(verdict(take(ops(0, 0, 10)))).toBe("unattempted");
    expect(verdict(take(ops(0, 0, 10, 3)))).toBe("unattempted");
    // Words heard, but none of the line's: something else was said.
    expect(verdict(take(ops(0, 10, 0)))).toBe("unattempted");
    expect(verdict(scoreLine("Hail to your lordship.", "um uh"))).toBe("unattempted");
  });

  it("is generous with short lines: one missing word is still complete", () => {
    expect(verdict(scoreLine("Yes, my lord.", "Yes my lady"))).toBe("complete");
    expect(verdict(scoreLine("Yes, my lord.", "yes my"))).toBe("complete");
    expect(verdict(scoreLine("Yes, my lord.", "yes"))).toBe("partial");
    expect(verdict(scoreLine("Aye.", "I"))).toBe("complete");
    expect(verdict(scoreLine("Yes, my lord.", ""))).toBe("unattempted");
    expect(scoreLabel(scoreLine("Yes, my lord.", "yes my lord"))).toBe("Complete");
    expect(scoreLabel(scoreLine("Yes, my lord.", "yes"))).toBe("Partial");
  });

  it("labels silent takes", () => {
    const silent = noSpeechResult("Hail to your lordship.");
    expect(silent.accuracy).toBe(0);
    expect(scoreLabel(silent)).toBe("Not attempted");
    expect(verdict(silent)).toBe("unattempted");
  });

  it("counts verdicts for a summary, leaving out zeros", () => {
    const results = [
      scoreLine("one two three four", "one two three four"),
      scoreLine("five six seven eight", "five six seven"),
      scoreLine("To be, or not to be, that is the question.", "to be"),
    ];
    const counts = verdictCounts(results);
    expect(counts).toEqual({ complete: 2, partial: 1, unattempted: 0 });
    expect(formatVerdictCounts(counts)).toBe("2 complete · 1 partial");
    expect(formatVerdictCounts({ complete: 0, partial: 0, unattempted: 2 })).toBe("2 not attempted");
  });

  it("micro-averages several lines", () => {
    const a = scoreLine("one two three four", "one two three four");
    const b = scoreLine("five six", "five");
    expect(overallAccuracy([a, b])).toBeCloseTo(5 / 6);
    expect(overallAccuracy([])).toBeNull();
  });

  it("returns the cleaned transcript", () => {
    const result = scoreLine("Hail to your lordship.", "[BLANK_AUDIO] Hail to your lordship.");
    expect(result.transcript).toBe("Hail to your lordship.");
    expect(result.accuracy).toBe(1);
  });
});

describe("annotateLine", () => {
  it("maps ops back onto the written words", () => {
    const result = scoreLine("I'll speak to it, though hell itself should gape!", "I will speak to it though hell itself gape now");
    const annotated = annotateLine("I'll speak to it, though hell itself should gape!", result.ops);
    expect(annotated).not.toBeNull();
    const words = annotated!.words;
    expect(words[0]).toMatchObject({ text: "I'll", state: "ok" });
    expect(words.find((w) => w.text === "should")?.state).toBe("missed");
    expect(words.at(-1)).toMatchObject({ text: "gape!", extra: ["now"] });
  });

  it("marks substitutions with what was heard", () => {
    const result = scoreLine("Get thee to a nunnery.", "Get thee to a bakery");
    const annotated = annotateLine("Get thee to a nunnery.", result.ops)!;
    expect(annotated.words.at(-1)).toMatchObject({ state: "changed", heard: "bakery" });
  });

  it("returns null when the text no longer matches the ops", () => {
    const result = scoreLine("Old text here", "old text here");
    expect(annotateLine("Completely different", result.ops)).toBeNull();
  });
});
