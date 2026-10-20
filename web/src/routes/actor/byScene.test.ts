import { describe, expect, it } from "vitest";
import { byScene } from "./byScene";

const item = (id: string, sectionId: string, sectionTitle: string) => ({ id, line: { sectionId }, sectionTitle });

describe("byScene", () => {
  it("puts lines under their scenes in script order", () => {
    const groups = byScene([item("a", "s1", "Act 1, Scene 1"), item("b", "s1", "Act 1, Scene 1"), item("c", "s2", "Act 1, Scene 2")]);
    expect(groups.map((g) => [g.title, g.items.map((i) => i.id)])).toEqual([
      ["Act 1, Scene 1", ["a", "b"]],
      ["Act 1, Scene 2", ["c"]],
    ]);
  });

  it("keeps a scene together even when its lines arrive apart", () => {
    const groups = byScene([item("a", "s1", "One"), item("b", "s2", "Two"), item("c", "s1", "One")]);
    expect(groups.map((g) => g.items.map((i) => i.id))).toEqual([["a", "c"], ["b"]]);
  });

  it("is empty for no lines", () => {
    expect(byScene([])).toEqual([]);
  });
});
