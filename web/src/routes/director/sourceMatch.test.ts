import { describe, expect, it } from "vitest";
import type { Line } from "../../api/types";
import { coverEnd, matchTextItems, pageForLine, sourceRange } from "./sourceMatch";

const line = (seq: number, sourceLine: number | null, text = "x", page: number | null = null): Line => ({
  id: `l${seq}`,
  seq,
  sectionId: "s",
  kind: "dialogue",
  characterId: null,
  text,
  flagged: false,
  flagReason: null,
  sourceLine,
  page,
});

describe("sourceRange", () => {
  it("runs to just before the next passage", () => {
    const lines = [line(1, 10), line(2, 10), line(3, 14), line(4, 20)];
    expect(sourceRange(lines, lines[0]!)).toEqual({ start: 10, end: 13 });
    // A stage direction cut from the same passage shares its range.
    expect(sourceRange(lines, lines[1]!)).toEqual({ start: 10, end: 13 });
    expect(sourceRange(lines, lines[2]!)).toEqual({ start: 14, end: 19 });
  });

  it("guesses from the text at the end of the script, and caps long spans", () => {
    const last = line(1, 50, "one\ntwo\nthree");
    expect(sourceRange([last], last)).toEqual({ start: 50, end: 54 });
    const lines = [line(1, 1), line(2, 500)];
    expect(sourceRange(lines, lines[0]!)).toEqual({ start: 1, end: 61 });
  });

  it("is null for old parses without positions", () => {
    const old = line(1, null);
    expect(sourceRange([old], old)).toBeNull();
  });
});

describe("pageForLine", () => {
  it("prefers the line's page, then the source text's page", () => {
    expect(pageForLine(line(1, 5, "x", 3))).toBe(3);
    expect(pageForLine(line(1, 5), new Map([[5, 2]]))).toBe(2);
    expect(pageForLine(line(1, null))).toBeNull();
  });
});

describe("matchTextItems", () => {
  const items = ["HAMLET", "Who's there? Nay, an-", "swer me: stand,", "and unfold yourself.", "BERNARDO", "Long live the king!"];

  it("finds a line across items, ignoring punctuation and hyphenation", () => {
    expect(matchTextItems(items, "Who's there? Nay, answer me: stand, and unfold yourself.")).toEqual([1, 2, 3]);
    expect(matchTextItems(items, "Long live the king!")).toEqual([5]);
  });

  it("falls back to the start or end of a line split across pages", () => {
    const thisPage = ["Some other text", "To be, or not to be, that is the question:", "Whether tis nobler"];
    expect(matchTextItems(thisPage, "To be, or not to be, that is the question: Whether tis nobler in the mind to suffer")).toEqual([1, 2]);
    const nextPage = ["The slings and arrows of outrageous fortune,", "Or to take arms"];
    expect(matchTextItems(nextPage, "Whether tis nobler in the mind to suffer The slings and arrows of outrageous fortune,")).toEqual([0]);
  });

  it("returns nothing for missing or tiny text", () => {
    expect(matchTextItems(items, "Something else entirely here")).toEqual([]);
    expect(matchTextItems(items, "Ay")).toEqual([]);
    expect(matchTextItems([], "Who is there")).toEqual([]);
  });
});

describe("coverEnd", () => {
  const source = [
    { n: 9, text: "KING. Though yet of Hamlet" },
    { n: 10, text: "our dear brother's death" },
    { n: 11, text: "" },
    { n: 12, text: "LAERTES. My dread lord," },
  ];

  it("stops once the line's letters are covered", () => {
    expect(coverEnd(source, 9, "Though yet of Hamlet our dear brother's death", 40)).toBe(10);
    expect(coverEnd(source, 9, "Though yet", 40)).toBe(9);
  });

  it("never passes the given end", () => {
    expect(coverEnd(source, 9, "x".repeat(500), 11)).toBe(11);
    expect(coverEnd(source, 9, "", 11)).toBe(9);
  });
});
