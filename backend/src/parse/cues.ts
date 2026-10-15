import { abbreviates, bestCue } from "./assemble.ts";
import { flag } from "./flags.ts";
import type { Segment } from "./label.ts";

// The model reads each chunk on its own and sometimes merges several speeches into one block or
// shifts a speaker by one. Across the whole script, though, it reliably learns which cues are
// printed ("POLONIUS", "Ham."). These checks use that list to re-split speeches at cue lines the
// model missed, and to correct a block whose first line carries a different character's cue.

const REPAIR_NOTE = flag("missed_cue", "Split at a cue the parser missed");
const SPEAKER_NOTE = flag("speaker", "The cue on this line names another character");

export interface CueBook {
  cues: string[]; // as printed, longest first
  speakerOf: Map<string, string>; // cue -> the speaker name it was most often given
  lineOnly: Set<string>; // mixed-case cues ("Bobchinsky") that only count as a whole line
}

const isCaps = (s: string) => /\p{Lu}/u.test(s) && s === s.toUpperCase();

// A cue the model used at least three times that is unmistakable at a line start: all capitals
// ("POLONIUS", "LADY MACBETH"), ending in a full stop or colon ("Ham.", "Hedda:"), or a plain
// name printed alone on its line ("Bobchinsky").
export function learnCues(segments: Segment[], lines: string[] = []): CueBook {
  const counts = new Map<string, Map<string, number>>();
  const lineOnly = new Set<string>();
  for (const s of segments) {
    if (s.type !== "speech" || !s.speaker) continue;
    const cue = bestCue(s.cue, s.speaker);
    if (!cue || cue.replace(/[^\p{L}]/gu, "").length < 2) continue;
    const bare = cue.replace(/[.:]$/, "");
    // A plain mixed-case name counts when it is printed as a line of its own above the speech.
    const standalone = lines[s.from - 1]?.trim() === cue;
    if (!isCaps(bare) && !/[.:]$/.test(cue)) {
      if (!standalone) continue;
      lineOnly.add(cue);
    }
    const m = counts.get(cue) ?? new Map<string, number>();
    m.set(s.speaker, (m.get(s.speaker) ?? 0) + 1);
    counts.set(cue, m);
  }
  const speakerOf = new Map<string, string>();
  for (const [cue, m] of counts) {
    const total = [...m.values()].reduce((a, b) => a + b, 0);
    if (total < 3) continue;
    speakerOf.set(cue, [...m].sort((a, b) => b[1] - a[1])[0]![0]);
  }
  return { cues: [...speakerOf.keys()].sort((a, b) => b.length - a.length), speakerOf, lineOnly };
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Returns the cue a line opens with, if it is a speaker cue rather than words that happen to
// start the same way.
export function lineCue(line: string, book: CueBook, prevLine: string | null): string | null {
  const l = line.trim();
  if (!l) return null;
  for (const cue of book.cues) {
    if (!l.startsWith(cue)) continue;
    if (book.lineOnly.has(cue) && l !== cue) continue;
    const rest = l.slice(cue.length);
    // Cue alone, or with a short direction: "HAMLET", "HAMLET, aside", "KING [to Laertes]".
    if (/^\s*[.:]?\s*$/.test(rest) || /^\s*(?:,\s*[\p{Ll}][^.!?]{0,40}|[([][^)\]]{0,60}[)\]])\s*[.:]?$/u.test(rest)) return cue;
    if (/[.:]$/.test(cue)) {
      // "Ham. To be" or "MRS LINDE.No.": a dotted cue followed by words, at the start of a speech.
      const sentenceStart = prevLine === null || !prevLine.trim() || /[.!?:;—"”’)\]]\s*$/.test(prevLine.trim());
      if (sentenceStart && /^\s*\S/.test(rest)) return cue;
      continue;
    }
    // "BARNARDO Who's there?": a capitalised cue followed by a capitalised word.
    if (isCaps(cue) && /^[\s.:]+["“‘'(\[]?[\p{Lu}]/u.test(rest)) return cue;
    // "LORD FANCOURT (aside to JACK). You know…": a cue, a delivery note, then the speech.
    if (/^\s*[([][^)\]]{1,80}[)\]][\s.:,]+\S/.test(rest)) return cue;
  }
  return null;
}

// Re-splits speech blocks at cue lines inside them and corrects the speaker of a block whose own
// first line carries another character's cue.
export function repairCues(segments: Segment[], lines: string[], book: CueBook): Segment[] {
  if (!book.cues.length) return segments;
  const out: Segment[] = [];
  for (const seg of claimOrphanCues(segments, lines, book)) {
    if (seg.type !== "speech" && seg.type !== "continue") {
      out.push(seg);
      continue;
    }
    let current: Segment = { ...seg };
    const firstCue = lineCue(lines[seg.from - 1]!, book, seg.from > 1 ? lines[seg.from - 2]! : null);
    if (firstCue) {
      const speaker = book.speakerOf.get(firstCue)!;
      // A "continuation" that opens with a cue line is a new speech.
      if (seg.type === "continue") current = { ...current, type: "speech", speaker, cue: firstCue, flag: current.flag ?? REPAIR_NOTE };
      // Only a cue that cannot be this speaker overrides the model ("Hedda:" fits HEDDA TESMAN).
      else if (speaker !== seg.speaker && !(seg.speaker && abbreviates(firstCue, seg.speaker))) current = { ...current, speaker, cue: firstCue, flag: current.flag ?? SPEAKER_NOTE };
    }
    for (let n = seg.from + 1; n <= seg.to; n++) {
      const cue = lineCue(lines[n - 1]!, book, lines[n - 2]!);
      if (!cue) continue;
      out.push({ ...current, to: n - 1 });
      current = {
        from: n,
        to: seg.to,
        type: "speech",
        speaker: book.speakerOf.get(cue)!,
        cue,
        act: null,
        scene: null,
        inlineDirections: seg.inlineDirections,
        flag: REPAIR_NOTE,
      };
    }
    out.push(current);
  }
  return out;
}

// A cue line the model labelled as a direction or skipped, followed by lines it labelled as a
// continuation or as a speech without that cue, is the start of a new speech.
function claimOrphanCues(segments: Segment[], lines: string[], book: CueBook): Segment[] {
  const out: Segment[] = [];
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    const next = segments[i + 1];
    const first = lines[seg.from - 1]!.trim();
    const cue = seg.type === "direction" || seg.type === "skip" ? lineCue(first, book, seg.from > 1 ? lines[seg.from - 2]! : null) : null;
    const cueOnly = cue !== null && first.length <= cue.length + 45 && !/[a-z].*[.!?]\s*\S/.test(first.slice(cue.length));
    const speechFollows = next !== undefined && (next.type === "continue" || next.type === "speech");
    if (cue && !cueOnly && seg.type === "direction") {
      // A whole speech, cue and all, that the model called a direction.
      out.push({ ...seg, type: "speech", speaker: book.speakerOf.get(cue)!, cue, flag: seg.flag ?? REPAIR_NOTE });
      continue;
    }
    if (!cue || !cueOnly || (seg.type === "skip" && !speechFollows)) {
      out.push(seg);
      continue;
    }
    const speaker = book.speakerOf.get(cue)!;
    if (seg.from === seg.to && speechFollows && next!.from === seg.to + 1 && next!.type === "continue") {
      out.push({ ...next!, from: seg.from, type: "speech", speaker, cue, flag: next!.flag ?? REPAIR_NOTE });
      i++;
      continue;
    }
    // The cue line on its own; the speech after it (past any "(Aside)") is claimed in assembly.
    out.push({ ...seg, to: seg.from, type: "speech", speaker, cue, inlineDirections: [], flag: REPAIR_NOTE });
    if (seg.to > seg.from) out.push({ ...seg, from: seg.from + 1, type: "direction" });
  }
  return out;
}

const RECLAIM_NOTE = flag("text", "The parser marked this as not part of the play");

// Once the play has started, a block labelled "not part of the play" that holds lines opening
// with this script's cues is dialogue the model dropped: split it into speeches at those cues.
// Before the first speech nothing changes, so a cast list or contents page stays skipped.
export function reclaimSkips(segments: Segment[], lines: string[], book: CueBook, playStarted: boolean): Segment[] {
  if (!book.cues.length) return segments;
  const out: Segment[] = [];
  let started = playStarted;
  for (const seg of segments) {
    if (seg.type === "speech") started = true;
    if (seg.type !== "skip" || !started) {
      out.push(seg);
      continue;
    }
    const cueLines: { n: number; cue: string }[] = [];
    for (let n = seg.from; n <= seg.to; n++) {
      const cue = lineCue(lines[n - 1]!, book, n > 1 ? lines[n - 2]! : null);
      if (cue) cueLines.push({ n, cue });
    }
    if (!cueLines.length) {
      out.push(seg);
      continue;
    }
    const blank = { speaker: null, cue: null, act: null, scene: null, inlineDirections: [] as string[] };
    if (cueLines[0]!.n > seg.from) out.push({ ...blank, from: seg.from, to: cueLines[0]!.n - 1, type: "direction", flag: RECLAIM_NOTE });
    cueLines.forEach(({ n, cue }, i) => {
      const end = i + 1 < cueLines.length ? cueLines[i + 1]!.n - 1 : seg.to;
      out.push({ ...blank, from: n, to: end, type: "speech", speaker: book.speakerOf.get(cue)!, cue, flag: RECLAIM_NOTE });
    });
  }
  return out;
}
