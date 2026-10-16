import { describe, expect, it } from "vitest";
import { sceneLabel } from "./sceneLabel";

const names = new Map([
  ["d", "DUNCAN"],
  ["m", "MALCOLM"],
  ["c", "CAPTAIN"],
  ["l", "LENNOX"],
  ["r", "ROSS"],
  ["w", "FIRST WITCH"],
  ["ml", "LADY MACBETH"],
  ["o", "O'Brien"],
]);

describe("scene picker labels", () => {
  it("lists who speaks, in order, in title case", () => {
    expect(sceneLabel("Act 1, Scene 1", ["w", "ml"], names)).toBe("Act 1, Scene 1 · First Witch, Lady Macbeth");
  });

  it("counts the rest after four names", () => {
    expect(sceneLabel("Act 1, Scene 2", ["d", "m", "c", "l", "r"], names)).toBe("Act 1, Scene 2 · Duncan, Malcolm, Captain, Lennox +1");
  });

  it("keeps names that are already mixed case, and skips unknown ids", () => {
    expect(sceneLabel("Prologue", ["o", "x"], names)).toBe("Prologue · O'Brien");
  });

  it("is just the title when nobody speaks", () => {
    expect(sceneLabel("Interval", [], names)).toBe("Interval");
  });
});
