import { describe, expect, it } from "vitest";
import {
  alignPartial,
  applyPass,
  decideAdvance,
  END_SILENCE_MS,
  endPauseMs,
  ENERGY_LONG_SILENCE_MS,
  ENERGY_SILENCE_MS,
  matchedCount,
  MID_LINE_SILENCE_MS,
  nextPassInterval,
  pieceStates,
  segmentLine,
  startProgress,
  startVad,
  vadStep,
  type AdvanceInput,
  type LiveProgress,
} from "./live";

/** Feeds a sequence of growing transcripts, as the live loop would, and returns the cursor after each. */
function replay(text: string, passes: (string | { windowed: string })[]): { cursors: number[]; progress: LiveProgress; total: number } {
  const { tokens } = segmentLine(text);
  let progress = startProgress(tokens.length);
  const cursors: number[] = [];
  for (const pass of passes) {
    progress = typeof pass === "string" ? applyPass(progress, tokens, pass) : applyPass(progress, tokens, pass.windowed, true);
    cursors.push(progress.cursor);
  }
  return { cursors, progress, total: tokens.length };
}

describe("segmentLine", () => {
  it("keeps the text verbatim and lists the words to listen for", () => {
    const text = "To be, or not  to be:\n  that is the question.";
    const { pieces, tokens } = segmentLine(text);
    expect(pieces.map((p) => p.text).join("")).toBe(text);
    expect(tokens).toEqual("to be or not to be that is the question".split(" "));
  });

  it("leaves [bracketed] directions out of the words", () => {
    const text = "Good night, [Aside] sweet prince. [Exit]";
    const { pieces, tokens } = segmentLine(text);
    expect(tokens).toEqual(["good", "night", "sweet", "prince"]);
    expect(pieces.filter((p) => p.kind === "direction").map((p) => p.text)).toEqual(["[Aside]", "[Exit]"]);
    expect(pieces.map((p) => p.text).join("")).toBe(text);
  });

  it("treats an unclosed bracket as a direction to the end", () => {
    const { tokens } = segmentLine("Farewell [he goes");
    expect(tokens).toEqual(["farewell"]);
  });

  it("expands contractions and numbers into several tokens for one word", () => {
    const { pieces, tokens } = segmentLine("I'm 21 today");
    expect(tokens).toEqual(["i", "am", "twenty", "one", "today"]);
    expect(pieces[0]).toMatchObject({ text: "I'm", tokenStart: 0, tokenEnd: 2 });
    expect(pieces[2]).toMatchObject({ text: "21", tokenStart: 2, tokenEnd: 4 });
  });
});

describe("pieceStates", () => {
  const { pieces } = segmentLine("I'm here [smiles] — now");

  it("lights whole words up to the cursor and hints the next one", () => {
    const states = pieceStates(pieces, 2).filter((s) => s !== "space");
    expect(states).toEqual(["lit", "next", "direction", "ahead", "ahead"]);
  });

  it("never hints a direction or a lone dash as next", () => {
    const states = pieceStates(pieces, 3).filter((s) => s !== "space");
    expect(states).toEqual(["lit", "lit", "direction", "lit", "next"]);
  });

  it("shows nothing lit before the first word", () => {
    expect(pieceStates(pieces, 0).filter((s) => s === "lit")).toEqual([]);
  });

  it("does not light a word half way through its tokens", () => {
    expect(pieceStates(pieces, 1)[0]).toBe("next");
  });
});

describe("applyPass", () => {
  const hamlet = "To be, or not to be, that is the question.";

  it("follows a clean read word by word", () => {
    const { cursors } = replay(hamlet, ["To be", "To be or not", "To be, or not to be, that", "To be or not to be, that is the question."]);
    expect(cursors).toEqual([2, 4, 7, 10]);
  });

  it("moves past a skipped word", () => {
    const { cursors, progress } = replay(hamlet, ["To be not to be", "To be not to be that is the question"]);
    expect(cursors).toEqual([6, 10]);
    expect(matchedCount(progress)).toBe(9);
  });

  it("moves past a misheard word", () => {
    const { cursors } = replay("The quality of mercy is not strained", ["the quantity of mercy", "the quantity of mercy is knot strained"]);
    expect(cursors).toEqual([4, 7]);
  });

  it("copes with a restart (repeated words)", () => {
    const text = "Now is the winter of our discontent made glorious summer";
    const { cursors } = replay(text, ["Now is the", "Now is the, now is the winter", "Now is the now is the winter of our discontent made glorious summer"]);
    expect(cursors).toEqual([3, 4, 10]);
  });

  it("reaches the end of a line that repeats its own words after a restart", () => {
    // "to be or to be or" can also be read as a skip, so the cursor may run a word or two ahead mid-way.
    const { cursors } = replay(hamlet, ["To be or", "To be or to be or not", "To be or to be or not to be that is the question"]);
    expect(cursors[0]).toBe(3);
    expect(cursors[2]).toBe(10);
  });

  it("does not jump ahead on one stray word", () => {
    const { cursors } = replay(hamlet, ["question"]);
    expect(cursors).toEqual([0]);
  });

  it("does not jump to a later copy of a repeated phrase", () => {
    const { cursors } = replay(hamlet, ["to be"]);
    expect(cursors).toEqual([2]);
  });

  it("never moves back when a later pass hears less", () => {
    const { cursors } = replay(hamlet, ["to be or not to be", "to be or"]);
    expect(cursors).toEqual([6, 6]);
  });

  it("matches contractions said in full and long forms said short", () => {
    expect(replay("I'll not go, it's late", ["I will not go it is late"]).cursors).toEqual([7]);
    expect(replay("I will not go, it is late", ["I'll not go, it's late"]).cursors).toEqual([7]);
  });

  it("matches numbers whether heard as digits or words", () => {
    expect(replay("Give me 3 ducats", ["give me three ducats"]).cursors).toEqual([4]);
    expect(replay("Give me three thousand ducats", ["give me 3000 ducats"]).cursors).toEqual([5]);
  });

  it("matches compounds split by the recogniser", () => {
    expect(replay("Tomorrow and tomorrow", ["to morrow and to morrow"]).cursors).toEqual([3]);
  });

  it("ignores directions, fillers and non-speech markers", () => {
    const { cursors, total } = replay("[Kneeling] Good my lord, [rising] farewell.", ["um good my", "[BLANK_AUDIO] good my lord uh farewell"]);
    expect(total).toBe(4);
    expect(cursors).toEqual([2, 4]);
  });

  it("follows a windowed transcript that starts mid-line", () => {
    const text = "Now is the winter of our discontent made glorious summer by this sun of York";
    const { cursors } = replay(text, ["Now is the winter of our discontent", { windowed: "of our discontent made glorious summer" }, { windowed: "made glorious summer by this sun of York" }]);
    expect(cursors).toEqual([7, 10, 15]);
  });

  it("lets a windowed transcript start with a cut-off word", () => {
    const text = "Now is the winter of our discontent made glorious summer";
    const { cursors } = replay(text, ["Now is the winter of our", { windowed: "ur discontent made glorious" }]);
    expect(cursors).toEqual([6, 9]);
  });

  it("ignores an empty pass", () => {
    expect(replay(hamlet, ["", "   "]).cursors).toEqual([0, 0]);
  });
});

describe("alignPartial", () => {
  it("costs skipped words before a free start", () => {
    const expected = "a b c d e f".split(" ");
    expect(alignPartial(expected, ["e", "f"], 0, 4).matched).toEqual([4, 5]);
    expect(alignPartial(expected, ["e"], 0, 0).matched).toEqual([]);
  });
});

describe("decideAdvance", () => {
  // 10 words: about 3 s of voiced speech for the whole line, so 1.8 s counts as having said it.
  const base: AdvanceInput = { mode: "live", totalTokens: 10, cursor: 10, speechMs: 2000, silenceMs: 0, caughtUp: true };

  it("waits while the actor is still speaking", () => {
    expect(decideAdvance({ ...base, silenceMs: 200 })).toBe("wait");
  });

  it("moves on after a short pause once the cursor is in the last 30% of the line", () => {
    expect(decideAdvance({ ...base, silenceMs: 700 })).toBe("advance");
    expect(decideAdvance({ ...base, cursor: 7, silenceMs: 600 })).toBe("wait");
    expect(decideAdvance({ ...base, cursor: 7, silenceMs: 700 })).toBe("advance");
    expect(endPauseMs({ ...base, cursor: 8 })).toBe(END_SILENCE_MS);
  });

  it("moves on after a moderate pause when enough was said but the words weren't heard", () => {
    const missed = { ...base, cursor: 3, speechMs: 3000 };
    expect(decideAdvance({ ...missed, silenceMs: 1400 })).toBe("wait");
    expect(decideAdvance({ ...missed, silenceMs: 1500 })).toBe("advance");
    expect(decideAdvance({ ...base, cursor: 0, silenceMs: 1500 })).toBe("advance");
  });

  it("moves on after a moderate pause when the transcript lags behind the speech", () => {
    const lagging = { ...base, cursor: 5, caughtUp: false };
    expect(decideAdvance({ ...lagging, silenceMs: 1500 })).toBe("advance");
    expect(decideAdvance({ ...lagging, caughtUp: true, silenceMs: 1500 })).toBe("wait");
  });

  it("waits longer through a pause mid-line, then still moves on", () => {
    const mid = { ...base, cursor: 5, speechMs: 1500 };
    expect(decideAdvance({ ...mid, silenceMs: 2900 })).toBe("wait");
    expect(decideAdvance({ ...mid, silenceMs: 3000 })).toBe("advance");
    expect(endPauseMs({ ...base, cursor: 5 })).toBe(MID_LINE_SILENCE_MS);
  });

  it("never holds a take that had speech", () => {
    for (let cursor = 0; cursor <= 10; cursor++) {
      for (const speechMs of [300, 900, 2000, 6000]) {
        for (const caughtUp of [true, false]) {
          expect(decideAdvance({ ...base, cursor, speechMs, caughtUp, silenceMs: MID_LINE_SILENCE_MS })).toBe("advance");
        }
      }
    }
  });

  it("never stops before any speech", () => {
    expect(decideAdvance({ ...base, cursor: 0, speechMs: 0, silenceMs: 10_000 })).toBe("wait");
    expect(decideAdvance({ ...base, cursor: 0, speechMs: 200, silenceMs: 10_000 })).toBe("wait");
  });

  it("ends a short line quickly when its last word is missed", () => {
    const short = { ...base, totalTokens: 3, speechMs: 800 };
    expect(decideAdvance({ ...short, cursor: 3, silenceMs: 700 })).toBe("advance");
    expect(decideAdvance({ ...short, cursor: 2, silenceMs: 800 })).toBe("wait");
    expect(decideAdvance({ ...short, cursor: 2, silenceMs: 1500 })).toBe("advance");
  });

  it("without a transcript, uses speech time for the line to pick the pause", () => {
    const energy = { ...base, mode: "energy" as const, cursor: 0 };
    expect(decideAdvance({ ...energy, silenceMs: ENERGY_SILENCE_MS - 100 })).toBe("wait");
    expect(decideAdvance({ ...energy, silenceMs: ENERGY_SILENCE_MS })).toBe("advance");
    expect(decideAdvance({ ...energy, speechMs: 600, silenceMs: ENERGY_LONG_SILENCE_MS - 100 })).toBe("wait");
    expect(decideAdvance({ ...energy, speechMs: 600, silenceMs: ENERGY_LONG_SILENCE_MS })).toBe("advance");
    expect(decideAdvance({ ...energy, speechMs: 100, silenceMs: 5000 })).toBe("wait");
  });

  it("replays a take end to end: transcripts and levels in, one decision out", () => {
    const text = "Get thee to a nunnery.";
    const { tokens } = segmentLine(text);
    let progress = startProgress(tokens.length);
    let vad = startVad();
    const decisions: string[] = [];
    // 100 ms frames: 0.3 s quiet, 1.5 s speech, then quiet, with a transcript every 0.4 s.
    const transcripts = new Map([[800, "get thee"], [1200, "get thee to a"], [1600, "get thee to a nun"], [2000, "get thee to a nunnery"]]);
    for (let t = 100; t <= 3000; t += 100) {
      vad = vadStep(vad, t > 300 && t <= 1800 ? -22 : -70, 100);
      const heard = transcripts.get(t);
      if (heard) progress = applyPass(progress, tokens, heard);
      decisions.push(
        decideAdvance({ mode: "live", totalTokens: tokens.length, cursor: progress.cursor, speechMs: vad.speechMs, silenceMs: vad.silenceMs, caughtUp: true }),
      );
    }
    const first = decisions.indexOf("advance");
    expect(decisions.slice(0, first).every((d) => d === "wait")).toBe(true);
    // Speech ends at 1.8 s; the move comes 0.7 s later.
    expect((first + 1) * 100).toBe(2500);
  });

  it("replays a take the model didn't understand: it still moves on after a pause", () => {
    const { tokens } = segmentLine("Get thee to a nunnery.");
    let progress = startProgress(tokens.length);
    let vad = startVad();
    let first = -1;
    for (let t = 100; t <= 4000 && first < 0; t += 100) {
      vad = vadStep(vad, t > 300 && t <= 1800 ? -22 : -70, 100);
      if (t === 1200) progress = applyPass(progress, tokens, "kept her");
      if (t === 2000) progress = applyPass(progress, tokens, "kept her through ornery");
      const d = decideAdvance({ mode: "live", totalTokens: tokens.length, cursor: progress.cursor, speechMs: vad.speechMs, silenceMs: vad.silenceMs, caughtUp: true });
      if (d === "advance") first = t;
    }
    expect(progress.cursor).toBeLessThan(tokens.length * 0.7);
    // Speech ends at 1.8 s; 1.5 s of speech is enough for five words, so the move comes 1.5 s later.
    expect(first).toBe(3300);
  });
});

describe("vadStep", () => {
  it("counts speech above the noise floor and silence after it", () => {
    let vad = startVad();
    for (let i = 0; i < 10; i++) vad = vadStep(vad, -65, 20);
    expect(vad.speechMs).toBe(0);
    for (let i = 0; i < 25; i++) vad = vadStep(vad, -25, 20);
    expect(vad.speechMs).toBeGreaterThanOrEqual(400);
    expect(vad.silenceMs).toBe(0);
    for (let i = 0; i < 40; i++) vad = vadStep(vad, -65, 20);
    expect(vad.silenceMs).toBe(800);
  });

  it("ignores a single click", () => {
    let vad = startVad();
    for (let i = 0; i < 10; i++) vad = vadStep(vad, -65, 20);
    vad = vadStep(vad, -10, 20);
    for (let i = 0; i < 10; i++) vad = vadStep(vad, -65, 20);
    expect(vad.speechMs).toBe(0);
  });

  it("adapts to a noisy room", () => {
    let vad = startVad();
    for (let i = 0; i < 200; i++) vad = vadStep(vad, -40, 20);
    expect(vad.speechMs).toBe(0);
    for (let i = 0; i < 10; i++) vad = vadStep(vad, -20, 20);
    expect(vad.speechMs).toBeGreaterThan(0);
  });
});

describe("nextPassInterval", () => {
  it("backs off when passes are slow", () => {
    expect(nextPassInterval(100)).toBe(350);
    expect(nextPassInterval(600)).toBe(870);
    expect(nextPassInterval(5000)).toBe(2000);
  });
});
