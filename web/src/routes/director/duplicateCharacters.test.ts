import { describe, expect, it } from "vitest";
import type { Character } from "../../api/types";
import { baseName, suggestMerges } from "./duplicateCharacters";

const c = (name: string, lineCount: number): Character => ({ id: name, name, aliases: [], lineCount });
const pairs = (chars: Character[]) => suggestMerges(chars).map((s) => [s.from.name, s.into.name]);

describe("merge suggestions", () => {
  it("strips delivery notes and punctuation from names", () => {
    expect(baseName("MACBETH (ASIDE)")).toBe("MACBETH");
    expect(baseName("Macbeth, aside")).toBe("MACBETH");
    expect(baseName("KING [to Laertes]")).toBe("KING");
    expect(baseName("LADY MACBETH.")).toBe("LADY MACBETH");
  });

  it("suggests merging a name with a stage direction into the plain name", () => {
    expect(pairs([c("MACBETH", 140), c("MACBETH (ASIDE)", 4), c("BANQUO", 30)])).toEqual([["MACBETH (ASIDE)", "MACBETH"]]);
  });

  it("suggests abbreviations only when they fit one character", () => {
    expect(pairs([c("HAMLET", 300), c("HAM", 2)])).toEqual([["HAM", "HAMLET"]]);
    expect(pairs([c("LADY MACBETH", 50), c("LADY MACDUFF", 10), c("LADY MAC", 1)])).toEqual([]);
  });

  it("never suggests joint cues or unrelated names", () => {
    expect(pairs([c("MACBETH", 140), c("MACBETH AND BANQUO", 2), c("ALL", 3), c("MACDUFF", 40)])).toEqual([]);
  });

  it("keeps the character with the plain name even when the variant has more lines", () => {
    expect(pairs([c("CHORUS (SINGING)", 12), c("CHORUS", 3)])).toEqual([["CHORUS (SINGING)", "CHORUS"]]);
  });
});
