import type { ParsedLine } from "./types.ts";

// Text reduced to lowercase letters and digits, with a map back to raw offsets, so parser
// output can be located in the source regardless of spacing, punctuation or line wrapping.
export function normalizeWithMap(raw: string): { norm: string; map: number[] } {
  let norm = "";
  const map: number[] = [];
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!.toLowerCase();
    if (/[\p{L}\p{N}]/u.test(ch)) {
      norm += ch.normalize("NFD").replace(/\p{M}/gu, "");
      while (map.length < norm.length) map.push(i);
    }
  }
  return { norm, map };
}

export const normalize = (raw: string) => normalizeWithMap(raw).norm;

export interface AlignResult {
  lines: ParsedLine[];
  sourceChars: number;
  matchedChars: number;
  droppedChars: number;
}

const MAX_GAP = 12;
const SKIPPED = "The parser skipped this text; check where it belongs";
export const NOT_FOUND = "This text was not found in the script source";

// Walks parser output through the source in order. Source text the parser left out (other than
// speaker cues) is re-inserted as a flagged line, so nothing is dropped silently; output that
// cannot be found in the source is flagged.
export function alignToSource(source: string, lines: ParsedLine[], cueNames: string[]): AlignResult {
  const { norm, map } = normalizeWithMap(source);
  const cues = [...new Set(cueNames.map(normalize).filter((c) => c.length > 0))].sort((a, b) => b.length - a.length);
  const out: ParsedLine[] = [];
  let cursor = 0;
  let matched = 0;
  let dropped = 0;

  const checkGap = (end: number) => {
    if (end <= cursor) return;
    let gap = norm.slice(cursor, end);
    for (const cue of cues) gap = gap.split(cue).join("");
    if (gap.length > MAX_GAP) {
      const text = stripCues(source.slice(map[cursor], map[end - 1]! + 1).replace(/\s+/g, " ").trim(), cueNames);
      out.push({ kind: "stage_direction", speaker: null, speakerAsWritten: null, text, act: null, scene: null, flagReason: SKIPPED });
      dropped += gap.length;
    }
  };

  for (const line of lines) {
    const t = normalize(line.text);
    if (!t) continue;
    const pos = norm.indexOf(t, cursor);
    if (pos < 0) {
      const head = t.slice(0, Math.min(24, t.length));
      const tail = t.slice(-Math.min(24, t.length));
      const start = norm.indexOf(head, cursor);
      const end = start >= 0 ? norm.indexOf(tail, start) : -1;
      if (start >= 0 && end >= 0 && end - start < t.length * 1.5 + 40) {
        checkGap(start);
        out.push({ ...line, flagReason: line.flagReason ?? "Text differs slightly from the script source" });
        matched += end + tail.length - start;
        cursor = end + tail.length;
        continue;
      }
      out.push({ ...line, flagReason: NOT_FOUND });
      continue;
    }
    checkGap(pos);
    out.push(line);
    matched += t.length;
    cursor = pos + t.length;
  }
  checkGap(norm.length);
  return { lines: out, sourceChars: norm.length, matchedChars: matched, droppedChars: dropped };
}

// Drops speaker cues at either end of a re-inserted gap ("... vanishes. OPHELIA").
function stripCues(text: string, cueNames: string[]): string {
  const escaped = cueNames.filter((c) => c.trim()).map((c) => c.trim().replace(/[.:]+$/, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (!escaped.length) return text;
  const names = `(?:${escaped.sort((a, b) => b.length - a.length).join("|")})[.:]?`;
  return text.replace(new RegExp(`^${names}\\s+`, "i"), "").replace(new RegExp(`\\s+${names}$`, "i"), "").trim() || text;
}
