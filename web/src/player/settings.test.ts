import { describe, expect, it } from "vitest";
import { defaultSettings, MY_PART, parseSettings, roleCharacters } from "./settings";

describe("run-through settings", () => {
  const roles = new Set([MY_PART, "c1", "c2"]);

  it("actors start on their own part, directors with no role", () => {
    expect(defaultSettings(true, "full")).toEqual({ role: MY_PART, mode: "read", speed: 1 });
    expect(defaultSettings(false, "full")).toEqual({ role: "", mode: "read", speed: 1 });
    expect(defaultSettings(true, "mine").mode).toBe("pause");
  });

  it("restores what was saved, and drops anything this production doesn't allow", () => {
    const fallback = defaultSettings(false, "full");
    expect(parseSettings(JSON.stringify({ role: "c2", mode: "skip", speed: 2.5 }), fallback, roles)).toEqual({ role: "c2", mode: "skip", speed: 2.5 });
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
