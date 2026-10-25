import { describe, expect, it } from "vitest";
import { DEMO_LINES, hasRecording, pauseMs, spokenMs, tokenize, wordsSaid, wordStarts } from "./demoScript";

describe("the landing demo", () => {
  it("uses no synthesized voices: it waits for a real-cast recording of every line", () => {
    expect(hasRecording()).toBe(false);
    expect(hasRecording(DEMO_LINES.map((l) => ({ ...l, audio: "/demo/x.m4a" })))).toBe(true);
    expect(hasRecording([{ ...DEMO_LINES[0]!, audio: "/demo/x.m4a" }, DEMO_LINES[1]!])).toBe(false);
    expect(DEMO_LINES.some((l) => l.mine)).toBe(true);
  });

  it("keeps [directions] whole and never counts them as words", () => {
    const tokens = tokenize("[Looking on his hands] This is a sorry sight.");
    expect(tokens[0]).toEqual({ text: "[Looking on his hands]", word: false, direction: true });
    expect(tokens.filter((t) => t.word).map((t) => t.text)).toEqual(["This", "is", "a", "sorry", "sight."]);
    expect(tokenize("Hark!\nWho").map((t) => t.text)).toEqual(["Hark!", "\n", "Who"]);
  });

  it("times lines by their words, and pauses a little longer for your own", () => {
    expect(spokenMs("Ay.")).toBe(900);
    expect(spokenMs("I have done the deed.")).toBe(5 * 400 + 300);
    expect(pauseMs(2000)).toBe(2500);
    expect(pauseMs(10_000)).toBe(11_500);
  });

  it("spreads word starts over a clip by length, or uses the given ones", () => {
    const starts = wordStarts("I have done the deed.", 2000);
    expect(starts).toHaveLength(5);
    expect(starts[0]).toBe(100);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
    expect(starts[4]!).toBeLessThan(1800);
    expect(wordStarts("Now.", 1000, [40])).toEqual([40]);
    expect(wordStarts("Now then.", 1000, [40])).toHaveLength(2);
    expect(wordsSaid(starts, 0)).toBe(0);
    expect(wordsSaid(starts, 100)).toBe(1);
    expect(wordsSaid(starts, 5000)).toBe(5);
  });
});
