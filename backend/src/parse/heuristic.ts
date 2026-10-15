import { flag, type Flag } from "./flags.ts";
import type { ParsedLine } from "./types.ts";

// Deterministic fallback parser for plain-text plays and screenplays. It flags liberally:
// anything it is unsure about goes to the director's review list.

const NUMBER_WORDS = ["ONE", "TWO", "THREE", "FOUR", "FIVE", "SIX", "SEVEN", "EIGHT", "NINE", "TEN", "ELEVEN", "TWELVE"];
const ORDINAL_WORDS = ["FIRST", "SECOND", "THIRD", "FOURTH", "FIFTH", "SIXTH", "SEVENTH", "EIGHTH", "NINTH", "TENTH", "ELEVENTH", "TWELFTH"];
const ORDINAL = String.raw`(?:[IVXLC]+|\d{1,2}|${NUMBER_WORDS.join("|")}|${ORDINAL_WORDS.join("|")})`;
// "ACT II", "Act the Fourth", "ACT 3, SCENE 2"; "FIRST ACT"; "SCENE IV", "Scene the Second".
const ACT_RE = new RegExp(String.raw`^(?:THE\s+)?ACT\s+(?:THE\s+)?(${ORDINAL})\b\.?(?:\s*[,.;:\-–—]?\s*SCENE\s+(?:THE\s+)?(${ORDINAL})\b\.?)?(.*)$`, "i");
const WORD_ACT_RE = new RegExp(String.raw`^(?:THE\s+)?(${ORDINAL_WORDS.join("|")})\s+ACT\b\.?(.*)$`, "i");
const SCENE_RE = new RegExp(String.raw`^SCENE\s+(?:THE\s+)?(${ORDINAL})\b\.?(.*)$`, "i");
const SHORT_REF_RE = /^([IVX]+)\.\s?([ivx]+|\d{1,2})\.?$/;
const SLUG_RE = /^(?:INT|EXT|INT\.?\/EXT|I\/E)[.\s].{2,}$/;
const SPECIAL_HEADING_RE = /^(PROLOGUE|EPILOGUE)\.?$/i;
const ENTRANCE_RE = /^(?:Enter|Exit|Exeunt|Re-?enter|Manet|Manent|Flourish|Sennet|Alarum|Alarums|Trumpets|Thunder)\b/;
const VOICE_EXTENSION_RE = /^(?:V\.?\s?O\.?|O\.?\s?S\.?|O\.?\s?C\.?|CONT['’]?D\.?|CONTINUED)$/i;
const STOPWORDS = new Set(
  "Yes No Oh O Well Now Ay Nay What Why Come Good Then So Here There Thus Ha Ah Alas Farewell Sir Madam Peace Look Hark Away Go Stay Hold Indeed Enter Exit Exeunt Mr Mrs Ms Dr St Fie Pray Adieu Amen True Note Page".split(" "),
);

const CAPS_NAME = String.raw`[A-Z][A-Z0-9'’&\-]*(?:[ .][A-Z][A-Z0-9'’&\-]*){0,3}`;
const STANDALONE_CUE_RE = new RegExp(String.raw`^(${CAPS_NAME})\.?\s*(?:[(\[]([^)\]]{1,40})[)\]])?\s*[.:]?$`);
const INLINE_CUE_RE = new RegExp(String.raw`^(${CAPS_NAME})\s*(?:[(\[]([^)\]]{1,40})[)\]])?\s*(?:[.:]\s+|:|\s{2,}|\t+)(.+)$`);
const TITLE_CUE_RE = /^([A-Z][a-z]{1,11}(?: [A-Z][a-z]{1,11})?)\.\s+(\S.*)$/;
const COLON_CUE_RE = /^([A-Z][A-Za-z'’\-]{1,15}(?: [A-Z][A-Za-z'’\-]{1,15}){0,2}):\s+(\S.*)$/;

export function romanToNumber(value: string): string {
  const upper = value.toUpperCase();
  const word = NUMBER_WORDS.indexOf(upper);
  if (word >= 0) return String(word + 1);
  const ordinal = ORDINAL_WORDS.indexOf(upper);
  if (ordinal >= 0) return String(ordinal + 1);
  if (/^\d+$/.test(upper)) return String(Number(upper));
  if (!/^[IVXLC]+$/.test(upper)) return value;
  const values: Record<string, number> = { I: 1, V: 5, X: 10, L: 50, C: 100 };
  let total = 0;
  for (let i = 0; i < upper.length; i++) {
    const v = values[upper[i]!]!;
    const next = values[upper[i + 1] ?? ""] ?? 0;
    total += v < next ? -v : v;
  }
  return String(total);
}

export function parseHeading(line: string): { act: string | null; scene: string | null } | null {
  if (line.length > 80) return null;
  let m = ACT_RE.exec(line);
  if (m && isHeadingTail(m[3]!)) return { act: romanToNumber(m[1]!), scene: m[2] ? romanToNumber(m[2]) : null };
  m = WORD_ACT_RE.exec(line);
  if (m && isHeadingTail(m[2]!)) return { act: romanToNumber(m[1]!), scene: null };
  m = SCENE_RE.exec(line);
  if (m && isHeadingTail(m[2]!)) return { act: null, scene: romanToNumber(m[1]!) };
  m = SHORT_REF_RE.exec(line);
  if (m) return { act: romanToNumber(m[1]!), scene: romanToNumber(m[2]!) };
  m = SPECIAL_HEADING_RE.exec(line);
  if (m) return { act: null, scene: m[1]!.charAt(0).toUpperCase() + m[1]!.slice(1).toLowerCase() };
  if (SLUG_RE.test(line) && line === line.toUpperCase()) return { act: null, scene: line };
  return null;
}

// A heading may name a place after it ("SCENE II. A room of state.") but is never a sentence of dialogue.
function isHeadingTail(tail: string): boolean {
  const t = tail.trim();
  return t === "" || (t.length < 70 && /^[.:,\-–—]?\s*[A-Z]/.test(t) && !/[?!]$/.test(t));
}

export function canonicalName(raw: string): string {
  return raw.trim().replace(/[.:,;]+$/, "").replace(/\s+/g, " ").trim().toUpperCase();
}

function isCapsName(name: string): boolean {
  const letters = name.replace(/[^A-Za-z]/g, "");
  return letters.length >= 2 && letters === letters.toUpperCase() && name.length <= 30 && !STOPWORDS.has(name.charAt(0) + name.slice(1).toLowerCase());
}

interface Cue {
  speaker: string;
  asWritten: string;
  extension: string | null;
  text: string | null;
}

function matchCue(line: string, titleCues: Set<string>): Cue | null {
  let m = STANDALONE_CUE_RE.exec(line);
  if (m && isCapsName(m[1]!)) return { speaker: canonicalName(m[1]!), asWritten: m[1]!.trim(), extension: m[2] ?? null, text: null };
  m = INLINE_CUE_RE.exec(line);
  if (m && isCapsName(m[1]!) && /[a-z]/.test(m[3]!)) {
    return { speaker: canonicalName(m[1]!), asWritten: m[1]!.trim(), extension: m[2] ?? null, text: m[3]!.trim() };
  }
  m = TITLE_CUE_RE.exec(line);
  if (m && titleCues.has(m[1]!)) return { speaker: canonicalName(m[1]!), asWritten: `${m[1]}.`, extension: null, text: m[2]!.trim() };
  m = COLON_CUE_RE.exec(line);
  if (m && !STOPWORDS.has(m[1]!.split(" ")[0]!)) return { speaker: canonicalName(m[1]!), asWritten: m[1]!, extension: null, text: m[2]!.trim() };
  return null;
}

// Title-case abbreviated cues ("Ham. Not so, my lord.") only count when they recur.
function findTitleCues(lines: string[]): Set<string> {
  const counts = new Map<string, number>();
  for (const line of lines) {
    const m = TITLE_CUE_RE.exec(line);
    if (m && !STOPWORDS.has(m[1]!.split(" ")[0]!)) counts.set(m[1]!, (counts.get(m[1]!) ?? 0) + 1);
  }
  return new Set([...counts].filter(([, n]) => n >= 3).map(([name]) => name));
}

// Splits "Not so. [Aside] I am too much..." into dialogue and stage-direction pieces.
export function splitInlineDirections(text: string): { kind: "dialogue" | "stage_direction"; text: string }[] {
  const parts: { kind: "dialogue" | "stage_direction"; text: string }[] = [];
  let last = 0;
  for (const m of text.matchAll(/\[[^\]]*\]|\([^)]*\)/g)) {
    const before = text.slice(last, m.index).trim();
    if (before) parts.push({ kind: "dialogue", text: before });
    parts.push({ kind: "stage_direction", text: m[0] });
    last = m.index + m[0].length;
  }
  const rest = text.slice(last).trim();
  if (rest) parts.push({ kind: "dialogue", text: rest });
  return parts;
}

interface Speaker {
  speaker: string;
  asWritten: string;
}

interface Block {
  kind: "dialogue" | "stage_direction";
  who: Speaker | null;
  parts: string[];
  flag: Flag | null;
  bracketOpen: boolean;
}

const UNATTRIBUTED = flag("direction", "No speaker found, so this was treated as a stage direction");

export function heuristicParse(source: string): ParsedLine[] {
  const rawLines = source.replace(/\r\n?/g, "\n").split("\n").map((l) => l.trim());
  const titleCues = findTitleCues(rawLines);
  const out: ParsedLine[] = [];
  let current: Block | null = null;
  let pending: Speaker | null = null;

  const emit = (kind: ParsedLine["kind"], who: Speaker | null, text: string, lineFlag: Flag | null) =>
    out.push({ kind, speaker: who?.speaker ?? null, speakerAsWritten: who?.asWritten ?? null, text, act: null, scene: null, flag: lineFlag });

  const flush = () => {
    const block = current;
    current = null;
    if (!block) return;
    const text = block.parts.join(" ").replace(/\s+/g, " ").trim();
    if (!text) return;
    if (block.kind === "stage_direction") return emit("stage_direction", null, text, block.flag);
    for (const piece of splitInlineDirections(text)) {
      emit(piece.kind, piece.kind === "dialogue" ? block.who : null, piece.text, piece.kind === "dialogue" ? block.flag : null);
    }
  };

  const start = (kind: Block["kind"], who: Speaker | null, text: string, blockFlag: Flag | null = null) => {
    current = { kind, who, parts: [text], flag: blockFlag, bracketOpen: false };
  };

  for (const raw of rawLines) {
    if (current?.bracketOpen) {
      current.parts.push(raw);
      if (/[)\]]/.test(raw)) {
        current.bracketOpen = false;
        flush();
      }
      continue;
    }
    if (!raw) {
      if (current?.kind === "dialogue") pending = null;
      flush();
      continue;
    }
    const heading = parseHeading(raw);
    if (heading) {
      flush();
      pending = null;
      out.push({ kind: "heading", speaker: null, speakerAsWritten: null, text: raw, act: heading.act, scene: heading.scene, flag: null });
      continue;
    }
    if (/^[(\[]/.test(raw)) {
      const who: Speaker | null = current?.kind === "dialogue" ? current.who : pending;
      if (!/[)\]]/.test(raw)) {
        flush();
        pending = who;
        current = { kind: "stage_direction", who: null, parts: [raw], flag: null, bracketOpen: true };
        continue;
      }
      if (splitInlineDirections(raw).every((p) => p.kind === "stage_direction")) {
        flush();
        pending = who;
        emit("stage_direction", null, raw, null);
        continue;
      }
      if (current?.kind === "dialogue") current.parts.push(raw);
      else if (who) {
        flush();
        start("dialogue", who, raw);
      } else {
        flush();
        start("stage_direction", null, raw, UNATTRIBUTED);
      }
      continue;
    }
    if (ENTRANCE_RE.test(raw)) {
      flush();
      pending = null;
      start("stage_direction", null, raw);
      continue;
    }
    const cue = matchCue(raw, titleCues);
    if (cue) {
      flush();
      const ext = cue.extension?.trim();
      if (ext && !VOICE_EXTENSION_RE.test(ext)) emit("stage_direction", null, `(${ext})`, null);
      pending = { speaker: cue.speaker, asWritten: cue.asWritten };
      if (cue.text !== null) start("dialogue", pending, cue.text);
      continue;
    }
    if (current) current.parts.push(raw);
    else if (pending) start("dialogue", pending, raw);
    else start("stage_direction", null, raw, UNATTRIBUTED);
  }
  flush();
  return flagUnusual(out);
}

function flagUnusual(lines: ParsedLine[]): ParsedLine[] {
  const counts = new Map<string, number>();
  for (const l of lines) if (l.speaker) counts.set(l.speaker, (counts.get(l.speaker) ?? 0) + 1);
  const dialogueCount = lines.filter((l) => l.kind === "dialogue").length;
  return lines.map((l) => {
    if (l.kind !== "dialogue" || l.flag) return l;
    if (counts.get(l.speaker!) === 1 && dialogueCount > 6) return { ...l, flag: flag("speaker", `${l.speaker} speaks only once here`) };
    if (l.text.length > 1500) return { ...l, flag: flag("missed_cue", "Very long speech") };
    return l;
  });
}
