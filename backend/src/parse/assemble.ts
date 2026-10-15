import { parseHeading } from "./heuristic.ts";
import type { Segment } from "./label.ts";
import type { ParsedLine } from "./types.ts";

// A dialogue line that continues the speech in progress before its chunk; the pipeline joins it
// to the previous chunk's last speech.
export interface AssembledLine extends ParsedLine {
  continuation?: boolean;
  // A cue with no words yet, at the end of a chunk: the next chunk's continuation is this speaker's.
  cueOnly?: boolean;
}

// Builds lines from labelled segments. All text comes from the source lines, so nothing can be
// invented; the model only decides where blocks start and end and who speaks.
interface Orphan {
  speaker: string;
  cue: string;
  note: string | null;
}

export function assembleSegments(segments: Segment[], lines: string[], opts: { parenDirections?: boolean } = {}): AssembledLine[] {
  const parens = opts.parenDirections ?? false;
  const out: AssembledLine[] = [];
  // A cue with no words after it ("NORA." on its own line) whose speech the model then labelled
  // as a direction because it opens with one ("_In a low voice._—Where is she?").
  let orphan: Orphan | null = null;
  const lastDialogue = (): { speaker: string; cue: string } | null => {
    const l = out.findLast((x) => x.kind === "dialogue" && x.speaker);
    return l ? { speaker: l.speaker!, cue: l.speakerAsWritten ?? l.speaker! } : null;
  };
  const texts = segments.map((sg) => (sg.type === "skip" ? "" : joinLines(lines.slice(sg.from - 1, sg.to))));
  for (const [index, seg] of segments.entries()) {
    if (seg.type === "skip") continue;
    const text = texts[index]!;
    const around = {
      closesNext: bracketBalance(texts[index + 1] ?? "", parens).closesFirst,
      openedBefore: bracketBalance(texts[index - 1] ?? "", parens).openAtEnd,
    };
    if (!text) continue;
    const before = out.length;
    const pending = orphan as Orphan | null; // (a cast: TypeScript narrows the loop variable to null)
    orphan = null;
    const lastSpeech = index > 0 && segments[index - 1]!.type !== "skip" ? lastDialogue() : null;
    if (seg.type === "direction") {
      const pieces = pending ? splitDirections(text, seg.inlineDirections, parens, around).map(asDirectionIfWrapped) : [];
      if (pending && pieces.some((p) => !p.direction)) {
        emitSpeech(out, pieces, { speaker: pending.speaker, cue: pending.cue, note: pending.note ?? seg.note, continuation: false });
      } else if (!pending && lastSpeech && around.openedBefore && spokenAfterClose(text, seg.inlineDirections, parens, around)) {
        // "letter.) Splendid, Jack!" after "…Wykeham. (Blots and folds": the direction closes and
        // the same speech carries on.
        const rest = splitDirections(text, seg.inlineDirections, parens, around).map(asDirectionIfWrapped);
        emitSpeech(out, rest, { speaker: lastSpeech.speaker, cue: lastSpeech.cue, note: seg.note ?? CARRY_NOTE, continuation: false });
      } else if (pending) {
        // A cue, then "(Aside)" on its own line: the cue is still waiting for its speech.
        out.push(line("stage_direction", null, null, text, seg.note));
        orphan = pending;
      } else if (seg.from === seg.to && actOrScene(text)) {
        // A plain "ACT II" / "SCENE 3" line the model called a direction.
        out.push({ ...line("heading", null, null, text, seg.note), ...actOrScene(text)! });
      } else if (actOrScene(lines[seg.from - 1]!.trim())) {
        // A heading folded into the scene description under it.
        const heading = lines[seg.from - 1]!.trim();
        out.push({ ...line("heading", null, null, heading, null), ...actOrScene(heading)! });
        const rest = joinLines(lines.slice(seg.from, seg.to));
        if (rest) out.push(line("stage_direction", null, null, rest, seg.note));
      } else {
        out.push(line("stage_direction", null, null, text, seg.note));
      }
    } else if (seg.type === "heading") {
      // The printed heading wins over the model's numbers when it can be read.
      const printed = actOrScene(text);
      const parsed = printed ?? parseHeading(text);
      // A heading with no number in it ("SCENE" above a setting) gets no number from the model.
      const numbered = printed !== null || HAS_NUMBER.test(text);
      out.push({
        ...line("heading", null, null, text, seg.note),
        act: printed ? printed.act : numbered ? (seg.act ?? parsed?.act ?? null) : (parsed?.act ?? null),
        scene: printed ? printed.scene : numbered ? (seg.scene ?? parsed?.scene ?? null) : (parsed?.scene ?? null),
      });
    } else {
      // A first line that is exactly the cue the model reported is a cue line, even when the name
      // is spelled unlike the speaker ("Euery man." for EVERY MAN).
      const reported = seg.cue?.trim() ?? "";
      const nameLike = reported.length > 1 && reported.length <= 40 && reported.split(/\s+/).length <= 4 && !/[,;!?]/.test(reported);
      const ownLine = seg.type === "speech" && seg.to > seg.from && nameLike && lines[seg.from - 1]!.trim() === reported;
      const cue = seg.type === "speech" ? (ownLine ? reported : preferSpeaker(bestCue(seg.cue, seg.speaker), seg.speaker)) : null;
      let body = seg.type === "speech" ? (ownLine ? joinLines(lines.slice(seg.from, seg.to)) : stripCue(text, [cue, seg.speaker])) : text;
      const cueDirection = seg.type === "speech" && seg.to > seg.from ? cueLineDirection(lines[seg.from - 1]!, [cue, seg.speaker]) : null;
      if (cueDirection) {
        out.push(line("stage_direction", null, null, cueDirection, null));
        body = joinLines(lines.slice(seg.from, seg.to));
      }
      const pieces = splitDirections(body, seg.inlineDirections, parens, around);
      // Words labelled as continuing a speech, after a cue that is still waiting, are that cue's.
      const owner = seg.type === "continue" && pending ? pending : null;
      const speaker: string | null = seg.type === "speech" ? seg.speaker : (owner?.speaker ?? null);
      const cueAsWritten: string | null = seg.type === "speech" ? (speaker ? (cue ?? speaker) : null) : (owner?.cue ?? null);
      const spoke = emitSpeech(out, pieces, { speaker, cue: cueAsWritten, note: seg.note ?? owner?.note ?? null, continuation: seg.type === "continue" && !owner });
      if (!spoke && speaker) orphan = { speaker, cue: cueAsWritten ?? speaker, note: seg.note };
    }
    for (let i = before; i < out.length; i++) out[i]!.sourceLine ??= seg.from;
  }
  if (orphan) out.push({ ...line("dialogue", orphan.speaker, orphan.cue, "", orphan.note), cueOnly: true });
  return out;
}

// Whether a block's text leaves a bracket open at its end, or closes one it didn't open.
export function bracketBalance(text: string, parens: boolean): { openAtEnd: boolean; closesFirst: boolean } {
  const openers = parens ? "[(" : "[";
  const closers = parens ? "])" : "]";
  let depth = 0;
  let closesFirst = false;
  for (const ch of text) {
    if (openers.includes(ch)) depth++;
    else if (closers.includes(ch)) {
      if (depth === 0) closesFirst = true;
      else depth--;
    }
  }
  return { openAtEnd: depth > 0, closesFirst };
}

const CARRY_NOTE = "This speech carries on after a stage direction; check the speaker";

function spokenAfterClose(text: string, inline: string[], parens: boolean, around: { closesNext?: boolean; openedBefore?: boolean }): boolean {
  return splitDirections(text, inline, parens, around).map(asDirectionIfWrapped).some((p) => !p.direction);
}

// "(Aside)" alone is a direction even in scripts whose parentheses are otherwise spoken.
function asDirectionIfWrapped(p: Piece): Piece {
  return !p.direction && /^\([^()]*\)\.?$/.test(p.text) ? { ...p, direction: true } : p;
}

// A delivery note on the cue's own line: "HAMLET, aside" or "KING [to Laertes]".
const CUE_LINE_DIRECTION = /^(?:,\s*([\p{Ll}][^.!?]{0,40})|[([]([^)\]]{1,60})[)\]])\s*[.:]?$/u;

export function cueLineDirection(firstLine: string, cues: (string | null)[]): string | null {
  const first = firstLine.trim();
  for (const c of cues) {
    if (!c) continue;
    const bare = c.replace(/[.:,]+$/, "");
    if (!bare || !first.toUpperCase().startsWith(bare.toUpperCase())) continue;
    const m = CUE_LINE_DIRECTION.exec(first.slice(bare.length).replace(/^[.:]/, "").trim());
    return m ? (m[1] ?? m[2])!.trim() : null;
  }
  return null;
}

// Emits the pieces of one speech; returns whether any spoken words were found.
function emitSpeech(
  out: AssembledLine[],
  pieces: Piece[],
  who: { speaker: string | null; cue: string | null; note: string | null; continuation: boolean },
): boolean {
  // One speech stays one line for the actor to record: directions printed inside it are lifted out
  // and placed before the speech, except ones after its last words, which follow it.
  const spoken = pieces.filter((p) => !p.direction);
  if (!spoken.length) {
    for (const p of pieces) out.push(line("stage_direction", null, null, p.text, null));
    return false;
  }
  const lastSpoken = pieces.lastIndexOf(spoken[spoken.length - 1]!);
  for (const [i, p] of pieces.entries()) if (p.direction && i < lastSpoken) out.push(line("stage_direction", null, null, p.text, null));
  const l: AssembledLine = line("dialogue", who.speaker, who.cue, spoken.map((p) => p.text).join(" "), who.note);
  if (who.continuation) l.continuation = true;
  out.push(l);
  for (const [i, p] of pieces.entries()) if (p.direction && i > lastSpoken) out.push(line("stage_direction", null, null, p.text, null));
  return true;
}

const HAS_NUMBER = /\d|\b[IVXLC]+\b|\b(?:one|two|three|four|five|six|seven|eight|nine|ten|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|last|final)\b/i;

// An act or scene number heading ("ACT II", "FIRST ACT", "Scene 3"), not a slugline or a prologue.
function actOrScene(text: string): { act: string | null; scene: string | null } | null {
  const h = parseHeading(text);
  if (!h) return null;
  return h.act !== null || /^\d+$/.test(h.scene ?? "") ? h : null;
}

const line = (kind: ParsedLine["kind"], speaker: string | null, speakerAsWritten: string | null, text: string, flagReason: string | null): AssembledLine => ({
  kind,
  speaker,
  speakerAsWritten,
  text,
  act: null,
  scene: null,
  flagReason,
});

// Joins wrapped lines. A word broken with a hyphen at a line end ("some-" / "thing") is rejoined.
export function joinLines(parts: string[]): string {
  const kept = parts.map((p) => p.replace(/\s+$/, "")).filter((p) => p.trim());
  if (!kept.length) return "";
  // Line breaks and indentation stay as printed (verse, songs, indented speeches), relative to
  // the block's least indented line.
  const indent = Math.min(...kept.map((l) => /^ */.exec(l)![0].length));
  let text = "";
  for (const raw of kept) {
    const l = raw.slice(indent);
    if (!text) text = l.trimStart();
    else if (/[a-z]-$/.test(text) && /^[a-z]/.test(l.trimStart())) text = text.slice(0, -1) + l.trimStart();
    else text += "\n" + l;
  }
  return text;
}

// Trims a piece of text without losing its inner line breaks and indentation.
export function tidyText(raw: string): string {
  return raw
    .split("\n")
    .map((l) => l.replace(/[ \t]+$/, "").replace(/(\S)[ \t]{2,}(?=\S)/g, "$1 "))
    .join("\n")
    .replace(/\n{2,}/g, "\n")
    .replace(/^\s+/, "")
    .replace(/\s+$/, "");
}

// The model sometimes copies spoken words into the cue ("BARNARDO Long live the King!"). Keep only
// the leading name part: capitalised words or an abbreviation ending in a full stop.
const TITLES = new Set(["MR", "MRS", "MS", "MISS", "DR", "ST", "MME", "MLLE", "MONS", "M", "REV", "PROF", "CAPT", "COL", "GEN", "LT", "SGT", "GOV", "SEN", "FR", "SR", "SRA", "HERR", "FRAU"]);

export function cueName(cue: string | null): string | null {
  if (!cue) return null;
  const words = cue.trim().split(/\s+/);
  const name: string[] = [];
  for (const w of words) {
    if (name.length >= 4) break;
    const bare = w.replace(/[.:,]+$/, "");
    if (!bare || !/^[\p{Lu}0-9][\p{Lu}\p{Ll}0-9'’-]*$/u.test(bare)) break;
    const isCaps = bare === bare.toUpperCase();
    if (name.length > 0 && bare.length === 1 && !/\.$/.test(w)) break; // "BARNARDO I have…", "HAMLET O…"
    if (!isCaps && name.length > 0 && !/[.:]$/.test(w)) break;
    name.push(w);
    const next = words[name.length];
    // "Sec. Off." and "Lady M.": a chain of short capitalised abbreviations is one cue.
    if (/[.:]$/.test(w) && next && /^\p{Lu}[\p{L}]{0,5}\.$/u.test(next)) continue;
    // "MRS. PEARCE", "Dr. Rank": a title is followed by the name it belongs to.
    if (/\.$/.test(w) && TITLES.has(bare.toUpperCase()) && next && /^\p{Lu}/u.test(next)) continue;
    if (/[.:]$/.test(w) || (!isCaps && name.length === 1 && words.length > 1 && !/^[\p{Lu}]/u.test(words[1]!))) break;
  }
  if (!name.length) return null;
  return name.join(" ");
}

// The longest leading part of the reported cue that fits the speaker: "Sec. Off." for SECOND
// OFFICER, but only "Ham." from "Ham. No." for HAMLET.
export function bestCue(cue: string | null, speaker: string | null): string | null {
  const name = cueName(cue);
  if (!name) return null;
  const words = name.split(" ");
  for (let n = words.length; n > 0; n--) {
    const candidate = trustedCue(words.slice(0, n).join(" "), speaker);
    if (candidate) return candidate;
  }
  return null;
}

// A cue that is the speaker's name plus extra words ("BARNARDO NOW") trusts the speaker name.
function preferSpeaker(cue: string | null, speaker: string | null): string | null {
  if (!cue || !speaker) return cue;
  const c = cue.toUpperCase().replace(/[.:]+$/, "");
  return c.startsWith(speaker.toUpperCase() + " ") ? speaker : cue;
}

const nameWords = (s: string) => s.toUpperCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim().split(" ").filter(Boolean);

// The cue the model reports, if it can really be this speaker's cue. The model sometimes puts the
// first spoken words in the cue field ("Yes, the principle"); those must not be stripped as a cue.
// A cue counts when each of its words starts a word of the speaker's name ("Ham." for HAMLET,
// "Lady B." for LADY BRACKNELL), or when it is an all-capitals name ("KING" for CLAUDIUS).
export function trustedCue(cue: string | null, speaker: string | null): string | null {
  if (!cue) return null;
  const bare = cue.replace(/[.:,]+$/, "");
  if (/\p{Lu}/u.test(bare) && bare === bare.toUpperCase() && bare.replace(/[^\p{L}]/gu, "").length >= 2) return cue;
  return speaker && abbreviates(cue, speaker) ? cue : null;
}

// Each word of the cue starts a word of the name, in order: "Sec. Off." / SECOND OFFICER.
export function abbreviates(cue: string, name: string): boolean {
  const cw = nameWords(cue);
  const sw = nameWords(name);
  if (!cw.length || cw.length > sw.length) return false;
  let j = 0;
  for (const w of cw) {
    while (j < sw.length && !sw[j]!.startsWith(w)) j++;
    if (j === sw.length) return false;
    j++;
  }
  return true;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Removes the speaker cue from the start of a speech ("HAM. To be", "BARNARDO Who's there?").
export function stripCue(text: string, cues: (string | null)[]): string {
  for (const cue of cues) {
    if (!cue) continue;
    const bare = cue.replace(/[.:]+$/, "").trim();
    if (!bare) continue;
    // The cue ends at punctuation (even with no space after, as in "MRS LINDE.No."), a space or a dash.
    const m = new RegExp(`^\\s*${escape(bare)}(?:\\s*[.:]\\s*|\\s+|\\s*$|(?=[([—–-]))`, "i").exec(text);
    if (m) return text.slice(m[0].length).replace(/^\s*[.:,]\s*/, "").trim();
  }
  return text;
}

interface Piece {
  text: string;
  direction: boolean;
}

// Square brackets are always editorial or stage directions. Parentheses are not: verse uses them
// for spoken asides ("(as sin's true nature is)"), so they are only cut when the model points at them.
// Underscores mark italics in plain text: a sentence in italics ("_Looking out anxiously._") is
// a direction; a single italic word ("I _do_ mean it") is emphasis and stays spoken.
const BRACKETED = /\[[^\]]{1,200}\]|(?<![\p{L}\p{N}])_[^_\n]{0,200}\s[^_\n]{0,200}[.!?]_(?![\p{L}\p{N}])/gu;
export const PARENTHESES = /\((?![a-z]\))[^()]{1,200}\)/g;
const EMPHASIS = /(?<![\p{L}\p{N}])_([^_\n]{1,200})_(?![\p{L}\p{N}])/gu;

// Cuts stage directions out of a speech: the ones the model pointed at, plus anything in
// square brackets or in _underscores_ (plain-text italics, as Project Gutenberg prints directions).
// The spoken text either side stays with the speaker.
export function splitDirections(
  text: string,
  inline: string[],
  parenDirections = false,
  around: { closesNext?: boolean; openedBefore?: boolean } = {},
): Piece[] {
  const spans: [number, number][] = [];
  let searchFrom = 0;
  for (const d of inline) {
    const at = findLoose(text, d, searchFrom);
    if (!at) continue;
    spans.push(at);
    searchFrom = at[1];
  }
  for (const m of text.matchAll(BRACKETED)) spans.push([m.index, m.index + m[0].length]);
  if (parenDirections) for (const m of text.matchAll(PARENTHESES)) spans.push([m.index, m.index + m[0].length]);
  // A direction opened at the end of a speech and closed in the next block ("… mad. [She sits
  // down" / "on the plinth.]"), or closed at the start of a speech after being opened in the
  // block before. Only when the neighbouring block confirms it: OCR text has stray brackets.
  const openers = parenDirections ? "[(" : "[";
  const closers = parenDirections ? "])" : "]";
  if (around.closesNext) {
    for (let i = text.length - 1; i >= 0; i--) {
      if (closers.includes(text[i]!)) break;
      if (openers.includes(text[i]!)) {
        spans.push([i, text.length]);
        break;
      }
    }
  }
  if (around.openedBefore) {
    for (let i = 0; i < text.length; i++) {
      if (openers.includes(text[i]!)) break;
      if (closers.includes(text[i]!)) {
        spans.push([0, i + 1]);
        break;
      }
    }
  }
  spans.sort((a, b) => a[0] - b[0]);

  const pieces: Piece[] = [];
  let pos = 0;
  for (const [start, end] of spans) {
    if (start < pos) continue;
    push(pieces, text.slice(pos, start), false);
    push(pieces, text.slice(start, end), true);
    pos = end;
  }
  push(pieces, text.slice(pos), false);
  return pieces;
}

function push(pieces: Piece[], raw: string, direction: boolean) {
  // Punctuation left at the start after a cut direction (", " or ". "), but not an ellipsis.
  let text = tidyText(raw).replace(/^(?:[,;:]|\.(?!\.))\s*/, "");
  // A dash left at the start of a speech after cutting a direction ("_Looking out._—Did you…").
  if (!direction) text = text.replace(/^[—–-]+\s*/, "").replace(EMPHASIS, "$1");
  else text = text.replace(/^_(.+)_$/, "$1");
  if (!/[\p{L}\p{N}]/u.test(text)) return;
  const last = pieces[pieces.length - 1];
  if (last && last.direction === direction) last.text += " " + text;
  else pieces.push({ text, direction });
}

// Finds a direction even when the model normalised spacing or curly quotes.
function findLoose(text: string, needle: string, from: number): [number, number] | null {
  const n = needle.trim();
  if (!n) return null;
  const exact = text.indexOf(n, from);
  if (exact >= 0) return [exact, exact + n.length];
  const pattern = n
    .split(/\s+/)
    .map((w) => escape(w).replace(/['’‘]/g, "['’‘]").replace(/["“”]/g, "[\"“”]"))
    .join("\\s+");
  const re = new RegExp(pattern, "gi");
  re.lastIndex = from;
  const m = re.exec(text);
  return m ? [m.index, m.index + m[0].length] : null;
}
