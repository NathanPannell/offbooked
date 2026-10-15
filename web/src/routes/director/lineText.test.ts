import { describe, expect, it } from "vitest";
import { splitAtCaret, textRuns } from "./lineText";

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
