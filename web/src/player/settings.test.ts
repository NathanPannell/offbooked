import { describe, expect, it, vi } from "vitest";
import { changeSettings, defaultSettings, loadPlace, MY_PART, parseSettings, roleCharacters, savePlace } from "./settings";

describe("run-through settings", () => {
  const roles = new Set([MY_PART, "c1", "c2"]);

  it("cast members start on their own part with a pause to say their lines; others just listen", () => {
    expect(defaultSettings(true, "full")).toEqual({ role: MY_PART, mode: "pause" });
    expect(defaultSettings(true, "mine")).toEqual({ role: MY_PART, mode: "pause" });
    // A listener with no part (or the director): "Just listening", and a part picked later reads out.
    expect(defaultSettings(false, "full")).toEqual({ role: "", mode: "read" });
    expect(defaultSettings(false, "mine").mode).toBe("pause");
  });

  it("keeps a cast member's own choice of mode over the default", () => {
    const picked = changeSettings(defaultSettings(true, "full"), { mode: "read" });
    expect(picked.modePicked).toBe(true);
    expect(parseSettings(JSON.stringify(picked), defaultSettings(true, "full"), roles).mode).toBe("read");
  });

  it("remembers Everything, the one way to hear the whole play with a part", () => {
    const picked = changeSettings(defaultSettings(true, "full"), { mode: "all" });
    expect(parseSettings(JSON.stringify(picked), defaultSettings(true, "full"), roles).mode).toBe("all");
  });

  it("remembers the line reached per production, and forgets it once the play has finished", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
      removeItem: (k: string) => store.delete(k),
    });
    try {
      expect(loadPlace("p1")).toBeNull();
      savePlace("p1", "line-9");
      expect(loadPlace("p1")).toBe("line-9");
      expect(loadPlace("p2")).toBeNull();
      savePlace("p1", null);
      expect(loadPlace("p1")).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("doesn't let a mode saved along with another change stick", () => {
    // Saved by an older version (or a speed tap, when speed was saved here) with the old default
    // "read": the new default wins, and an old per-production speed is dropped.
    const actor = defaultSettings(true, "full");
    expect(parseSettings(JSON.stringify({ role: MY_PART, mode: "read", speed: 1.5 }), actor, roles)).toEqual({ role: MY_PART, mode: "pause" });
    // Changing part saves the mode in force, but not as a choice.
    const moved = changeSettings(actor, { role: "c2" });
    expect(moved.modePicked).toBeUndefined();
    expect(parseSettings(JSON.stringify({ ...moved, mode: "read" }), actor, roles).mode).toBe("pause");
    // Once picked, it stays picked through later changes.
    const chosen = changeSettings(changeSettings(actor, { mode: "skip" }), { role: "c1" });
    expect(parseSettings(JSON.stringify(chosen), actor, roles)).toEqual({ role: "c1", mode: "skip", modePicked: true });
  });

  it("restores what was saved, and drops anything this production doesn't allow", () => {
    const fallback = defaultSettings(false, "full");
    expect(parseSettings(JSON.stringify({ role: "c2", mode: "skip", speed: 2.5, modePicked: true }), fallback, roles)).toEqual({
      role: "c2",
      mode: "skip",
      modePicked: true,
    });
    expect(parseSettings(JSON.stringify({ role: "gone", mode: "loop", speed: 7 }), fallback, roles)).toEqual(fallback);
    expect(parseSettings("{not json", fallback, roles)).toEqual(fallback);
    expect(parseSettings(null, fallback, roles)).toEqual(fallback);
    expect(parseSettings(JSON.stringify({ role: "" }), defaultSettings(true, "full"), roles).role).toBe("");
  });

  it("a role stands for the actor's own characters, one character, or none", () => {
    expect(roleCharacters(MY_PART, ["a", "b"])).toEqual(new Set(["a", "b"]));
    expect(roleCharacters("c1", ["a"])).toEqual(new Set(["c1"]));
    expect(roleCharacters("", ["a"])).toEqual(new Set());
  });
});
