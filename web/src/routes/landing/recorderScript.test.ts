import { describe, expect, it } from "vitest";
import { DEMO_LINES } from "./demoScript";
import { END_MS, LEAD_MS, lineMs, MOVE_MS, RECORDER_LINES, recorderAt, totalMs, WORD_MS, wordCount } from "./recorderScript";

describe("the landing page's recording demo", () => {
  it("records Lady Macbeth's lines from the listening demo, each with the line before it as its cue", () => {
    expect(RECORDER_LINES).toHaveLength(DEMO_LINES.filter((l) => l.mine).length);
    expect(RECORDER_LINES[0]).toEqual({ cueWho: "MACBETH", cue: DEMO_LINES[0]!.text, text: DEMO_LINES[1]!.text });
    expect(RECORDER_LINES.at(-1)!.text).toBe("A foolish thought, to say a sorry sight.");
  });

  it("lights each word in turn, ends the take after the last, and moves on to the next line by itself", () => {
    const first = RECORDER_LINES[0]!;
    const words = wordCount(first.text);
    expect(recorderAt(0)).toEqual({ index: 0, phase: "moving", heard: 0, recorded: 0 });
    expect(recorderAt(MOVE_MS)).toMatchObject({ index: 0, phase: "speaking", heard: 0 });
    expect(recorderAt(MOVE_MS + LEAD_MS)).toMatchObject({ phase: "speaking", heard: 1 });
    expect(recorderAt(MOVE_MS + LEAD_MS + 2 * WORD_MS + 1)).toMatchObject({ phase: "speaking", heard: 3 });
    expect(recorderAt(MOVE_MS + LEAD_MS + words * WORD_MS)).toEqual({ index: 0, phase: "ending", heard: words, recorded: 0 });
    expect(lineMs(first)).toBe(MOVE_MS + LEAD_MS + words * WORD_MS + END_MS);
    expect(recorderAt(lineMs(first))).toEqual({ index: 1, phase: "moving", heard: 0, recorded: 1 });
  });

  it("wraps once every line is in, and takes long enough to watch but not to drag", () => {
    expect(recorderAt(totalMs() - 1).phase).toBe("ending");
    expect(recorderAt(totalMs())).toEqual({ index: RECORDER_LINES.length, phase: "wrapped", heard: 0, recorded: RECORDER_LINES.length });
    expect(recorderAt(-50).phase).toBe("moving");
    expect(totalMs()).toBeGreaterThan(10_000);
    expect(totalMs()).toBeLessThan(25_000);
  });
});
