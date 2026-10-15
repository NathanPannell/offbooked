import { describe, expect, it } from "vitest";
import type { Line } from "../../api/types";
import { canJoinAtSeam, joinPreview, splitPoints, splitTokens, undoJoin } from "./lineJoin";

const names = (id: string) => ({ h: "HORATIO", m: "MARCELLUS" })[id];
const line = (seq: number, over: Partial<Line> = {}): Line => ({
  id: `l${seq}`,
  seq,
  sectionId: "s1",
  kind: "dialogue",
  characterId: "h",
  text: "Hail to your lordship.",
  flagged: false,
  flagReason: null,
  ...over,
});

describe("joining lines", () => {
  it("says plainly when both lines are the same speaker's", () => {
    const p = joinPreview(line(1), line(2), names);
    expect(p).toMatchObject({ label: "Join", differs: false, done: "Lines joined" });
    expect(p.description).toContain("HORATIO");
  });

  it("names the speaker who keeps the text when speakers differ (the upper line wins)", () => {
    const p = joinPreview(line(1), line(2, { characterId: "m" }), names);
    expect(p.differs).toBe(true);
    expect(p.label).toBe("Join as HORATIO");
    expect(p.description).toBe("Join MARCELLUS's line into HORATIO's line above. It all becomes HORATIO's.");
    expect(p.done).toBe("Joined. It's all HORATIO's now");
  });

  it("joins a spoken line into a direction above as a direction", () => {
    const p = joinPreview(line(1, { kind: "stage_direction", characterId: null }), line(2), names);
    expect(p.label).toBe("Join into direction");
    expect(p.done).toBe("Joined into the direction above");
  });

  it("shows seams only between neighbours in one scene", () => {
    expect(canJoinAtSeam(line(1), line(2))).toBe(true);
    expect(canJoinAtSeam(line(1), line(3))).toBe(false);
    expect(canJoinAtSeam(line(1), line(2, { sectionId: "s2" }))).toBe(false);
    expect(canJoinAtSeam(undefined, line(2))).toBe(false);
  });

  it("undoes a join by splitting where the upper text ended and restoring the lower line as it was", () => {
    const upper = line(1, { text: "Hail" });
    expect(undoJoin(upper, line(2, { characterId: "m", flagged: true, flagReason: "who?", sourceLine: 7, page: 2 }))).toEqual({
      at: 4,
      second: { kind: "dialogue", characterId: "m", flagged: true, flagReason: "who?", sourceLine: 7, sourcePage: 2 },
    });
    expect(undoJoin(upper, line(2, { kind: "stage_direction", characterId: "m" })).second.characterId).toBeNull();
  });
});

describe("splitting a line", () => {
  it("offers a split before every word but the first", () => {
    expect(splitPoints("  Hail to\nyour  lordship.")).toEqual([
      { at: 7, word: "to" },
      { at: 10, word: "your" },
      { at: 16, word: "lordship." },
    ]);
    expect(splitPoints("Alone")).toEqual([]);
  });

  it("keeps every character when cut into tokens, with offsets on words after the first", () => {
    const text = "  Hail to\nyour  lordship.";
    const tokens = splitTokens(text);
    expect(tokens.map((t) => t.text).join("")).toBe(text);
    expect(tokens.filter((t) => t.at !== null).map((t) => [t.at, text.slice(t.at!, t.at! + t.text.length)])).toEqual([
      [7, "to"],
      [10, "your"],
      [16, "lordship."],
    ]);
  });
});
