import { describe, expect, it } from "vitest";
import { applyPass, segmentLine, startProgress, startVad, VAD_MIN_RUN_MS, vadStep } from "./live";
import { addVoiced, notePass, pieceStarts, spokenPieceCount, startWordClock, takeWordStarts, tokenStarts, type Stretch, type TakeTiming } from "./wordTiming";

/** Stretches from a list of [start, end] pairs. */
const voiced = (...pairs: [number, number][]): Stretch[] => pairs.map(([startMs, endMs]) => ({ startMs, endMs }));

describe("addVoiced", () => {
  it("joins voiced time across the gaps between words, and starts a new stretch after a pause", () => {
    const s: Stretch[] = [];
    addVoiced(s, 300, 500);
    addVoiced(s, 340, 560); // the same run, growing
    addVoiced(s, 650, 800); // a 90 ms gap between words
    addVoiced(s, 1000, 1200); // a 200 ms pause
    expect(s).toEqual(voiced([300, 800], [1000, 1200]));
    expect(addVoiced(s, 900, 900)).toHaveLength(2);
  });
});

describe("notePass", () => {
  it("notes the words a pass reached first and the audio it heard", () => {
    let clock = startWordClock();
    clock = notePass(clock, 0, 2, 0, 800);
    clock = notePass(clock, 2, 2, 0, 1000); // heard nothing new
    clock = notePass(clock, 2, 4, 0, 1200);
    expect(clock.reaches).toEqual([
      { first: 0, last: 2, fromMs: 0, toMs: 800, afterMs: 0 },
      { first: 2, last: 4, fromMs: 0, toMs: 1200, afterMs: 1000 },
    ]);
    expect(clock.lastToMs).toBe(1200);
  });
});

describe("tokenStarts", () => {
  const tokens = segmentLine("Get thee to a nunnery.").tokens;

  it("puts each word on the voiced audio of the pass that first reached it", () => {
    // "get thee" 0.3–0.8 s, a breath, "to a nunnery" 1.0–1.8 s.
    const stretches = voiced([300, 800], [1000, 1800]);
    let clock = startWordClock();
    clock = notePass(clock, 0, 2, 0, 800);
    clock = notePass(clock, 2, 4, 0, 1200);
    clock = notePass(clock, 4, 5, 0, 2000);
    const starts = tokenStarts(clock, stretches, tokens, 2400)!;
    expect(starts[0]).toBe(300); // the first word starts with the voice
    expect(starts[1]).toBeGreaterThan(400);
    expect(starts[1]).toBeLessThan(800);
    expect(starts[2]).toBe(1000); // after the breath, where the voice comes back
    expect(starts[3]).toBeGreaterThan(1000);
    expect(starts[3]).toBeLessThan(1200);
    // The voice ran on past the second pass, so "nunnery" may have started a moment before it ended.
    expect(starts[4]).toBeGreaterThan(starts[3]! + 50);
    expect(starts[4]).toBeLessThan(1800);
  });

  it("never places a word in a pause", () => {
    const stretches = voiced([200, 600], [1500, 2500]);
    let clock = startWordClock();
    clock = notePass(clock, 0, 5, 0, 2600);
    const starts = tokenStarts(clock, stretches, tokens, 2600)!;
    for (const ms of starts) expect(stretches.some((s) => ms >= s.startMs && ms < s.endMs)).toBe(true);
    expect([...starts].sort((a, b) => a - b)).toEqual(starts);
  });

  it("lets a word cut off at the edge of a pass start just before it, when the voice ran on", () => {
    const stretches = voiced([300, 1600]);
    let clock = startWordClock();
    clock = notePass(clock, 0, 3, 0, 1000); // "get thee to", then "a" is cut off at 1.0 s
    clock = notePass(clock, 3, 5, 0, 1600);
    const starts = tokenStarts(clock, stretches, tokens, 1600)!;
    expect(starts[3]).toBeLessThan(1000);
    expect(starts[3]).toBeGreaterThan(starts[2]!);
  });

  it("keeps a windowed pass inside its window", () => {
    const stretches = voiced([0, 20_000]);
    let clock = startWordClock();
    clock = notePass(clock, 0, 2, 0, 8000);
    clock = notePass(clock, 2, 5, 13_000, 20_000);
    const starts = tokenStarts(clock, stretches, tokens, 20_000)!;
    expect(starts[2]).toBeGreaterThanOrEqual(13_000);
  });

  it("spreads words the cursor never reached over the rest of the voice", () => {
    const stretches = voiced([300, 800], [1000, 2400]);
    let clock = startWordClock();
    clock = notePass(clock, 0, 2, 0, 900); // then the recogniser lost the thread
    const starts = tokenStarts(clock, stretches, tokens, 3000)!;
    expect(starts).toHaveLength(5);
    expect(starts[4]).toBeGreaterThan(1000);
    expect(starts[4]).toBeLessThan(2400);
  });

  it("says nothing when no pass reached a word", () => {
    expect(tokenStarts(startWordClock(), voiced([0, 1000]), tokens, 1000)).toBeNull();
    expect(tokenStarts(notePass(startWordClock(), 0, 1, 0, 500), [], [], 1000)).toBeNull();
  });

  it("falls back to the pass's audio when it heard almost no voice", () => {
    const starts = tokenStarts(notePass(startWordClock(), 0, 2, 0, 1000), [], ["a", "b"], 1000)!;
    expect(starts).toEqual([0, 500]);
  });
});

describe("pieceStarts", () => {
  it("gives one start per printed word the character says, leaving [directions] and {notes} out", () => {
    const text = "Now go. [To the Servant.] Was it {beat} not";
    expect(spokenPieceCount(text)).toBe(5);
    const { tokens } = segmentLine(text);
    // The tracker listens for the note's word too (it may be said); the player never lights it.
    expect(tokens).toEqual(["now", "go", "was", "it", "beat", "not"]);
    expect(pieceStarts(text, [100, 300, 900, 1100, 1200, 1300])).toEqual([100, 300, 900, 1100, 1300]);
  });

  it("starts a word said as several tokens with its first", () => {
    const text = "I'm 21 today";
    expect(segmentLine(text).tokens).toEqual(["i", "am", "twenty", "one", "today"]);
    expect(pieceStarts(text, [0, 100, 300, 500, 800])).toEqual([0, 300, 800]);
  });

  it("puts a dash halfway between its neighbours, and never goes back", () => {
    const text = "Stay — go";
    expect(spokenPieceCount(text)).toBe(3);
    expect(pieceStarts(text, [200, 1000])).toEqual([200, 600, 1000]);
    expect(pieceStarts(text, [900, 400])).toEqual([900, 900, 900]);
  });

  it("covers a line opened by a (parenthesised) direction the tracker skips", () => {
    const text = "(aside) Well then";
    expect(spokenPieceCount(text)).toBe(3);
    expect(pieceStarts(text, [500, 800])).toEqual([500, 500, 800]);
  });
});

describe("takeWordStarts", () => {
  it("replays a take: levels and passes in, one start per word out, in ms of the recording", () => {
    const text = "Get thee to a nunnery.";
    const { tokens } = segmentLine(text);
    const timing: TakeTiming = { lineId: "l1", text, offsetMs: 40, clock: startWordClock(), stretches: [] };
    let progress = startProgress(tokens.length);
    let vad = startVad();
    const passes = new Map([
      [800, "get thee"],
      [1400, "get thee to a"],
      [2000, "get thee to a nunnery"],
    ]);
    // 20 ms frames: speech 0.3–0.8 s and 1.0–1.8 s.
    for (let t = 20; t <= 2400; t += 20) {
      vad = vadStep(vad, (t > 300 && t <= 800) || (t > 1000 && t <= 1800) ? -22 : -70, 20);
      if (vad.runMs >= VAD_MIN_RUN_MS) addVoiced(timing.stretches, vad.elapsedMs - vad.runMs, vad.elapsedMs);
      const heard = passes.get(t);
      if (heard) {
        const before = progress.cursor;
        progress = applyPass(progress, tokens, heard);
        timing.clock = notePass(timing.clock, before, progress.cursor, 0, t);
      }
    }
    const starts = takeWordStarts(timing, "l1", 2440)!;
    expect(starts).toHaveLength(5);
    expect(starts[0]).toBe(300 + 40);
    expect(starts[2]).toBe(1000 + 40);
    expect([...starts].sort((a, b) => a - b)).toEqual(starts);
    expect(takeWordStarts(timing, "other", 2440)).toBeNull();
    expect(takeWordStarts(null, "l1", 2440)).toBeNull();
    expect(takeWordStarts({ ...timing, clock: startWordClock() }, "l1", 2440)).toBeNull();
  });
});
