import { describe, expect, it } from "vitest";
import { applyPass, checkPass, flubbed, segmentLine, startLineCheck, startProgress, traceCursor, type LineCheck, type LiveProgress } from "./live";

describe("traceCursor", () => {
  it("moves on for the next word, or the one after it (one missed)", () => {
    expect(traceCursor(0, [0, 1, 2])).toBe(3);
    expect(traceCursor(2, [3])).toBe(4);
    expect(traceCursor(2, [4])).toBe(2);
  });

  it("jumps a few missed words only when the word after is heard too", () => {
    expect(traceCursor(0, [4, 5])).toBe(6);
    expect(traceCursor(0, [4, 6])).toBe(7);
    expect(traceCursor(0, [4])).toBe(0);
    // Too far ahead, even with company: that's not the next words.
    expect(traceCursor(0, [8, 9])).toBe(0);
  });

  it("never moves back for words already lit", () => {
    expect(traceCursor(5, [1, 2, 5])).toBe(6);
  });
});

describe("applyPass traces along", () => {
  const { tokens } = segmentLine("A little more than kin, and less than kind.");

  it("doesn't light the line for a cue read aloud that shares a word with it", () => {
    const p = applyPass(startProgress(tokens.length), tokens, "But now my cousin Hamlet and my son.");
    expect(p.cursor).toBe(0);
  });

  it("follows the line read after the cue", () => {
    const p = applyPass(startProgress(tokens.length), tokens, "But now my cousin Hamlet and my son, a little more than kin, and less than kind.");
    expect(p.cursor).toBe(tokens.length);
  });
});

describe("the wrong-line check", () => {
  const line = "A little more than kin, and less than kind.";
  const nearby = ["But now, my cousin Hamlet, and my son,\u2014", "Not so, my lord; I am too much i' the sun.", "How is it that the clouds still hang on you?"];
  const run = (text: string, transcripts: string[]): { progress: LiveProgress; check: LineCheck } => {
    const { tokens } = segmentLine(text);
    let progress = startProgress(tokens.length);
    let check = startLineCheck(nearby);
    for (const t of transcripts) {
      progress = applyPass(progress, tokens, t);
      check = checkPass(check, tokens, t);
    }
    return { progress, check };
  };
  const flagged = (transcripts: string[], text = line) => {
    const { progress, check } = run(text, transcripts);
    return flubbed(check, progress);
  };

  it("lets the line through read right, misheard, paraphrased or after its cue", () => {
    expect(flagged(["A little more than kin, and less than kind."])).toBe(false);
    expect(flagged(["A bit more than kin and less than kind."])).toBe(false);
    expect(flagged(["On the lower ticket, and less than done"])).toBe(false);
    expect(flagged(["But now my cousin Hamlet and my son, a little more than kin, and less than kind."])).toBe(false);
  });

  it("flags a take where most of the line wasn't heard", () => {
    expect(flagged(["Um, okay, give me one second."])).toBe(true);
    expect(flagged(["Not so, my lord, I am too much in the sun."])).toBe(true);
    expect(flagged(["But now my cousin Hamlet and my son."])).toBe(true);
  });

  it("flags a nearby line said instead, even when it shares words with this one", () => {
    // Half of this line's words are in the speaker's next line, all of which was heard.
    const text = "I am too much i' the sun, my good lord, and you know it well.";
    expect(flagged(["Not so, my lord, I am too much in the sun."], text)).toBe(true);
    expect(flagged(["I'm too much in the sun, my good lord, and you know it."], text)).toBe(false);
  });

  it("can't judge a take nothing was heard in", () => {
    expect(flagged([])).toBe(false);
    expect(flagged(["[BLANK_AUDIO]"])).toBe(false);
  });
});
