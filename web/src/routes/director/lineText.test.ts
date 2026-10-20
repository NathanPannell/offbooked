import { describe, expect, it } from "vitest";
import { repeatsSceneTitle, splitAtCaret, textRuns } from "./lineText";

describe("line text", () => {
  it("marks [bracketed] directions inside spoken lines", () => {
    const text = "Good night. [Exit Ghost.] Remember me.\n[Aside] Adieu!";
    const runs = textRuns(text, "dialogue");
    expect(runs).toEqual([
      { text: "Good night. ", direction: false },
      { text: "[Exit Ghost.]", direction: true },
      { text: " Remember me.\n", direction: false },
      { text: "[Aside]", direction: true },
      { text: " Adieu!", direction: false },
    ]);
    expect(runs.map((r) => r.text).join("")).toBe(text);
  });

  it("leaves directions, headings and unclosed brackets alone", () => {
    expect(textRuns("[Enter Hamlet]", "stage_direction")).toEqual([{ text: "[Enter Hamlet]", direction: false }]);
    expect(textRuns("Wait [for it", "dialogue")).toEqual([{ text: "Wait [for it", direction: false }]);
  });

  it("splits at the caret only when both halves keep some text", () => {
    expect(splitAtCaret("To be or not", 6)).toBe(6);
    expect(splitAtCaret("To be or not", 0)).toBeNull();
    expect(splitAtCaret("To be or not", 12)).toBeNull();
    expect(splitAtCaret("To be   ", 6)).toBeNull();
  });
});

describe("heading lines under a scene title", () => {
  const heading = (text: string) => ({ kind: "heading" as const, text });
  it("hides the ones that only repeat the title", () => {
    expect(repeatsSceneTitle(heading("ACT 1"), "Act 1, Scene 1")).toBe(true);
    expect(repeatsSceneTitle(heading("SCENE 1"), "Act 1, Scene 1")).toBe(true);
    expect(repeatsSceneTitle(heading("ACT I, SCENE II"), "Act 1, Scene 2")).toBe(true);
    expect(repeatsSceneTitle(heading("Scene iv"), "Act 3, Scene 4")).toBe(true);
  });
  it("keeps ones that say something else, and every other kind of line", () => {
    expect(repeatsSceneTitle(heading("SCENE 2"), "Act 1, Scene 1")).toBe(false);
    expect(repeatsSceneTitle(heading("Elsinore. A platform before the castle."), "Act 1, Scene 1")).toBe(false);
    expect(repeatsSceneTitle(heading("   "), "Act 1, Scene 1")).toBe(false);
    expect(repeatsSceneTitle({ kind: "stage_direction", text: "Act 1" }, "Act 1, Scene 1")).toBe(false);
  });
});
