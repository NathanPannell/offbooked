import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Cue, Line } from "../../api/types";
import { FlubPrompt } from "../../components/FlubPrompt";
import { autoRetake, FLUB_AUTO_LIMIT, flagsInRow, nearbyLines } from "./flub";

describe("flags in a row", () => {
  it("counts flags on one line, and starts again on another", () => {
    expect(flagsInRow(null, "a")).toBe(1);
    expect(flagsInRow({ lineId: "a", count: 1 }, "a")).toBe(2);
    expect(flagsInRow({ lineId: "a", count: 2 }, "b")).toBe(1);
  });

  it("re-records by itself the first time only: after two flags in a row it waits for a tap", () => {
    expect(autoRetake(1)).toBe(true);
    expect(autoRetake(FLUB_AUTO_LIMIT)).toBe(false);
    expect(FLUB_AUTO_LIMIT).toBe(2);
  });
});

describe("nearbyLines", () => {
  const line = (id: string, characterId: string, text: string, cue: string | null = null): { line: Line; cue: Cue | null } => ({
    line: { id, seq: 0, sectionId: "s", kind: "dialogue", characterId, text, flagged: false, flagReason: null },
    cue: cue ? { characterName: "X", text: cue, audioUrl: null } : null,
  });
  // A scene: KING, HAMLET, KING, QUEEN, HAMLET.
  const scene = [
    line("1", "king", "But now, my cousin Hamlet, and my son,"),
    line("2", "hamlet", "A little more than kin, and less than kind.", "But now, my cousin Hamlet, and my son,"),
    line("3", "king", "How is it that the clouds still hang on you?", "A little more than kin, and less than kind."),
    line("4", "queen", "Good Hamlet, cast thy nighted colour off,", "How is it that the clouds still hang on you?"),
    line("5", "hamlet", "Not so, my lord; I am too much i' the sun.", "Good Hamlet, cast thy nighted colour off,"),
  ];

  it("gives the cue, the lines either side, the line after's cue and the speaker's next line, once each", () => {
    expect(nearbyLines(scene, 1)).toEqual([
      "But now, my cousin Hamlet, and my son,",
      "How is it that the clouds still hang on you?",
      "Not so, my lord; I am too much i' the sun.",
    ]);
  });

  it("never offers the line itself, and nothing for no line", () => {
    expect(nearbyLines(scene, 4)).not.toContain(scene[4]!.line.text);
    expect(nearbyLines(scene, -1)).toEqual([]);
  });
});

describe("the flub prompt", () => {
  const render = (secondsLeft: number | null) => renderToStaticMarkup(createElement(FlubPrompt, { secondsLeft, onRetake: () => {}, onKeep: () => {} }));

  it("asks, with read it again on the left and keep it on the right", () => {
    const html = render(3);
    expect(html).toContain("Did you mean to say something else?");
    expect(html.indexOf("read it again")).toBeLessThan(html.indexOf("that&#x27;s what I said"));
    expect(html).toContain("Starting in 3");
  });

  it("shows no countdown when it waits for a tap, and never offers the take for another line", () => {
    const html = render(null);
    expect(html).not.toContain("Starting");
    expect(html.match(/<button/g)).toHaveLength(2);
    expect(html.toLowerCase()).not.toContain("another line");
  });
});
