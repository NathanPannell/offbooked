import { describe, expect, it } from "vitest";
import type { Character } from "../api/types";
import { saysLine, speakerLabel, voicesOf } from "./voices";

const chars = new Map<string, Character>(
  [
    { id: "a", name: "ANGELO", aliases: [], lineCount: 3 },
    { id: "e", name: "ESCALUS", aliases: [], lineCount: 2 },
    { id: "ae", name: "ANGELO, ESCALUS", aliases: [], lineCount: 1, group: true, memberIds: ["a", "e"] },
    { id: "all", name: "ALL", aliases: [], lineCount: 1, group: true, everyone: true },
  ].map((c) => [c.id, c]),
);

describe("shared line voices", () => {
  it("a line of one voice is its character's", () => {
    expect(voicesOf({ characterId: "a", voiceIds: null })).toEqual(["a"]);
    expect(saysLine({ characterId: "a", voiceIds: null }, new Set(["e"]))).toBe(false);
  });

  it("a shared line belongs to each of its voices", () => {
    const line = { characterId: "ae", voiceIds: ["a", "e"] };
    expect(voicesOf(line)).toEqual(["a", "e"]);
    expect(saysLine(line, new Set(["e"]))).toBe(true);
  });

  it("names who says an ALL line, but not a named group, which already says who", () => {
    expect(speakerLabel({ characterId: "all", voiceIds: ["a", "e"] }, chars)).toEqual({ name: "ALL", voices: "Angelo & Escalus" });
    expect(speakerLabel({ characterId: "ae", voiceIds: ["a", "e"] }, chars)).toEqual({ name: "ANGELO, ESCALUS", voices: null });
    expect(speakerLabel({ characterId: "a", voiceIds: null }, chars)).toEqual({ name: "ANGELO", voices: null });
  });
});
