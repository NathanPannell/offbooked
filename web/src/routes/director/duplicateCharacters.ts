import type { Character } from "../../api/types";

export interface MergeSuggestion {
  from: Character; // the duplicate, whose lines move
  into: Character; // the character to keep
  reason: string;
}

const JOINT = /[/&+]|,\s*\S+.*,|\bAND\b|\bBOTH\b|\bALL\b/i;

// The name without a delivery note or punctuation: "MACBETH (ASIDE)", "MACBETH, aside",
// "MACBETH [to Banquo]" and "MACBETH." are all MACBETH.
export function baseName(name: string): string {
  return name
    .replace(/\s*[([][^)\]]*[)\]]\s*/g, " ")
    .replace(/,\s*(?:aside|to\b.*|apart|within|aloud|sings?|reads?|singing|reading|whispers?|whispering)\s*$/i, "")
    .replace(/[^\p{L}\p{N}\s'-]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
}

const words = (s: string) => baseName(s).split(" ").filter(Boolean);

// "HAM" for HAMLET, "LADY M" for LADY MACBETH: each word starts the matching word of the full name.
function abbreviates(short: string, long: string): boolean {
  const sw = words(short);
  const lw = words(long);
  return sw.length > 0 && sw.length === lw.length && sw.every((w, i) => lw[i]!.startsWith(w)) && sw.join(" ") !== lw.join(" ");
}

// Pairs of characters that are very likely one person, so the director can merge them in one tap.
// Joint cues ("MACBETH AND BANQUO") are never suggested: they are a different line.
export function suggestMerges(characters: Character[]): MergeSuggestion[] {
  const out: MergeSuggestion[] = [];
  const taken = new Set<string>();
  const byLines = [...characters].sort((a, b) => b.lineCount - a.lineCount || a.name.length - b.name.length);
  for (const from of [...characters].sort((a, b) => a.lineCount - b.lineCount)) {
    if (taken.has(from.id) || JOINT.test(from.name)) continue;
    const base = baseName(from.name);
    if (!base) continue;
    // A plain name ("CHORUS") is never the duplicate of a variant ("CHORUS (SINGING)").
    const plain =
      baseName(from.name) ===
      from.name
        .toUpperCase()
        .replace(/[^\p{L}\p{N}\s'-]/gu, " ")
        .replace(/\s+/g, " ")
        .trim();
    const same = plain ? [] : byLines.filter((c) => c.id !== from.id && !taken.has(c.id) && !JOINT.test(c.name) && baseName(c.name) === base);
    const into = same.find((c) => c.name.toUpperCase() === base) ?? same[0];
    if (into) {
      out.push({ from, into, reason: "Same name with a stage direction" });
      taken.add(from.id);
      continue;
    }
    const longer = byLines.filter((c) => c.id !== from.id && !taken.has(c.id) && !JOINT.test(c.name) && abbreviates(from.name, c.name));
    if (longer.length === 1) {
      out.push({ from, into: longer[0]!, reason: "Abbreviated name" });
      taken.add(from.id);
    }
  }
  return out;
}
