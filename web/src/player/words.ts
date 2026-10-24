import type { SpokenSegment } from "../api/types";

// Word-by-word timing for the run-through: which word of a line is being said at a moment of its
// clip. A recorded take can say when each word starts (`wordStartsMs`), or at least where its speech
// is (`speech`); a synthesized clip says when each sentence (and each narrated [direction]) is
// spoken. Whatever isn't known is spread over the words by weight.

/** A word as printed: its place in the line's text and what of it is said. */
export interface WordToken {
  /** Character offsets into the line's text. */
  start: number;
  end: number;
  /** Inside a [bracketed] direction, read by the narrator. */
  narrator: boolean;
  /** Which printed line of the text it is on. */
  line: number;
  /** The words the voice says for it: usually one, none for {notes} and lines with no words. */
  pieces: string[];
}

export interface WordTime {
  startMs: number;
  endMs: number;
  /** False for printed text nobody says ({notes}, a lone "—" line): it never becomes the current word. */
  spoken: boolean;
}

const HAS_WORD = /[\p{L}\p{N}]/u;
const LETTERS = /[\p{L}\p{N}]/gu;

interface Region {
  from: number;
  to: number;
  narrator: boolean;
}

/**
 * The narrator's [bracketed] stretches of a dialogue line, as the server splits them: a bracket
 * closes at the next "]", or, unclosed, at the end of its printed line. A stage direction is all
 * narrator.
 */
function regions(text: string, kind: "dialogue" | "stage_direction"): Region[] {
  if (kind === "stage_direction") return [{ from: 0, to: text.length, narrator: true }];
  const out: Region[] = [];
  let at = 0;
  for (let open = text.indexOf("[", at); open !== -1; open = text.indexOf("[", at)) {
    if (open > at) out.push({ from: at, to: open, narrator: false });
    const close = text.indexOf("]", open + 1);
    const lineEnd = text.indexOf("\n", open);
    const end = close !== -1 ? close + 1 : lineEnd !== -1 ? lineEnd : text.length;
    out.push({ from: open, to: end, narrator: true });
    at = end;
  }
  if (at < text.length) out.push({ from: at, to: text.length, narrator: false });
  return out;
}

/** Offsets inside closed {braces}: notes the voice skips. */
function braceMask(text: string): boolean[] {
  const mask = new Array<boolean>(text.length).fill(false);
  for (const m of text.matchAll(/\{[^}]*\}/g)) for (let i = m.index; i < m.index + m[0].length; i++) mask[i] = true;
  return mask;
}

/** The printed words of a line, each with what the voice says for it. */
export function lineTokens(text: string, kind: "dialogue" | "stage_direction" = "dialogue"): WordToken[] {
  const braces = braceMask(text);
  const tokens: (WordToken & { group: string })[] = [];
  regions(text, kind).forEach((region, r) => {
    let line = 0;
    for (let i = 0; i < region.from; i++) if (text[i] === "\n") line++;
    let i = region.from;
    while (i < region.to) {
      if (/\s/.test(text[i]!)) {
        if (text[i] === "\n") line++;
        i++;
        continue;
      }
      const start = i;
      // A {note} inside the character's words is its own token, so the words around it still count.
      const inBrace = !region.narrator && braces[i]!;
      while (i < region.to && !/\s/.test(text[i]!) && (region.narrator || braces[i] === inBrace)) i++;
      const raw = text.slice(start, i);
      const said = region.narrator ? raw.replace(/[[\]{}()]/g, " ") : inBrace ? "" : raw;
      const pieces = said.replace(/[_*]+/g, "").split(/\s+/).filter(Boolean);
      tokens.push({ start, end: i, narrator: region.narrator, line, pieces, group: `${r}:${line}` });
    }
  });
  // A printed line with no words left (only "—", say) is not said at all.
  const wordy = new Set(tokens.filter((t) => t.pieces.some((p) => HAS_WORD.test(p))).map((t) => t.group));
  return tokens.map(({ group, ...t }) => (wordy.has(group) ? t : { ...t, pieces: [] }));
}

/** Pause weight after a word, from its punctuation. */
function pauseAfter(piece: string): number {
  if (/[.!?…—–:;]["'’”)\]]*$/.test(piece)) return 4;
  if (/[,]["'’”)\]]*$/.test(piece)) return 2;
  return 0;
}

/** A word's weight: its letters (a fair stand-in for its length when said), and a little more. */
function weight(piece: string): number {
  return 1.5 + (piece.match(LETTERS)?.length ?? 0);
}

interface Piece {
  token: number;
  text: string;
  /** A printed line starts after this piece. */
  lineBreakAfter: boolean;
}

/** Spreads [fromMs, toMs] over pieces by weight, with pauses for punctuation and line breaks. */
function spread(pieces: Piece[], fromMs: number, toMs: number, out: Span[]) {
  const weights = pieces.map((p, i) => {
    const last = i === pieces.length - 1;
    return { word: weight(p.text), pause: last ? 0 : pauseAfter(p.text) + (p.lineBreakAfter ? 3 : 0) };
  });
  const total = weights.reduce((s, w) => s + w.word + w.pause, 0) || 1;
  const perUnit = Math.max(0, toMs - fromMs) / total;
  let at = fromMs;
  for (const w of weights) {
    const startMs = at;
    at += w.word * perUnit;
    out.push({ startMs, endMs: at });
    at += w.pause * perUnit;
  }
}

/**
 * Lead-in and tail around the words of a recorded take (already trimmed to the speech): about the
 * trim's pads (TRIM in backend/src/render/trim.ts, 250 ms each side), less the soft start of the
 * first word and plus the voice dying away after the last.
 */
export const LEAD_MS = 220;
export const TAIL_MS = 290;
/** Piper leaves about this much quiet after each utterance, inside its segment. */
export const SEGMENT_TAIL_MS = 180;

/** A stretch of a clip, in ms. */
export interface Span {
  startMs: number;
  endMs: number;
}

/** What is known about when a clip's words are said. */
export interface ClipTimings {
  durationMs: number;
  /** A synthesized clip: when each sentence (and narrated [direction]) is said. */
  segments?: SpokenSegment[];
  /** A take: when each spoken piece starts. Used only with exactly one per piece. */
  wordStartsMs?: number[];
  /** A take: the stretches with speech in them. Words are kept out of the pauses between. */
  speech?: Span[];
}

/** The tail left after a clip's last word when nothing better is known. */
const tailOf = (durationMs: number) => Math.min(TAIL_MS, durationMs * 0.08);

/**
 * Each piece from its real start: it ends at the next piece's start or the end of the speech
 * stretch it starts in, whichever is first; the last one at its stretch's end, else the clip's
 * end less the tail.
 */
function fromStarts(starts: number[], speech: Span[], durationMs: number, out: Span[]) {
  let prev = 0;
  starts.forEach((raw, k) => {
    const startMs = Math.max(prev, raw);
    prev = startMs;
    const stretch = speech.find((s) => s.startMs <= startMs && startMs < s.endMs);
    const next = k + 1 < starts.length ? Math.max(startMs, starts[k + 1]!) : Infinity;
    let endMs = Math.min(next, stretch?.endMs ?? Infinity);
    if (endMs === Infinity) endMs = durationMs - tailOf(durationMs);
    out.push({ startMs, endMs: Math.max(startMs, endMs) });
  });
}

/**
 * Pieces spread over the speech stretches only: weighted as if the stretches ran end to end, then
 * each piece goes to the stretch its middle falls in and each stretch shares its time among its own.
 */
function overSpeech(pieces: Piece[], speech: Span[], out: Span[]) {
  const total = speech.reduce((t, s) => t + (s.endMs - s.startMs), 0);
  const virtual: Span[] = [];
  spread(pieces, 0, total, virtual);
  const groups: Piece[][] = speech.map(() => []);
  let stretch = 0;
  let before = 0; // speech time in the stretches before `stretch`
  pieces.forEach((p, k) => {
    const mid = (virtual[k]!.startMs + virtual[k]!.endMs) / 2;
    while (stretch < speech.length - 1 && mid >= before + (speech[stretch]!.endMs - speech[stretch]!.startMs)) {
      before += speech[stretch]!.endMs - speech[stretch]!.startMs;
      stretch++;
    }
    groups[stretch]!.push(p);
  });
  groups.forEach((own, i) => {
    if (own.length) spread(own, speech[i]!.startMs, speech[i]!.endMs, out);
  });
}

/**
 * When each printed word is said, in ms of the clip. A take's real word starts win when there is
 * one per piece; else its speech stretches share the time among the words with nothing in the
 * pauses. With segments (a synthesized clip), each segment's span is shared among its own words
 * and the gaps between segments are pauses. Without any (an older take or clip, or a silence the
 * listener fills), the whole duration is shared, less a short lead-in and tail.
 */
export function wordTimes(tokens: WordToken[], audio: ClipTimings): WordTime[] {
  const pieces: Piece[] = [];
  tokens.forEach((t, i) => t.pieces.forEach((text) => pieces.push({ token: i, text, lineBreakAfter: false })));
  // A new printed line, or the voice changing, is a pause.
  for (let k = 0; k < pieces.length - 1; k++) {
    const a = tokens[pieces[k]!.token]!;
    const b = tokens[pieces[k + 1]!.token]!;
    pieces[k]!.lineBreakAfter = a.line !== b.line || a.narrator !== b.narrator;
  }

  const times: Span[] = [];
  const speech = (audio.speech ?? []).filter((s) => s.endMs > s.startMs).sort((a, b) => a.startMs - b.startMs);
  const segments = (audio.segments ?? []).filter((s) => s.endMs > s.startMs);
  const counts = segments.map((s) => s.text.split(/\s+/).filter(Boolean).length);
  const matches = segments.length > 0 && counts.reduce((a, b) => a + b, 0) === pieces.length;
  if (pieces.length > 0 && audio.wordStartsMs?.length === pieces.length) {
    fromStarts(audio.wordStartsMs, speech, Math.max(0, audio.durationMs), times);
  } else if (pieces.length > 0 && speech.length > 0) {
    overSpeech(pieces, speech, times);
  } else if (matches) {
    let at = 0;
    segments.forEach((s, i) => {
      const own = pieces.slice(at, at + counts[i]!);
      at += counts[i]!;
      const tail = Math.min(SEGMENT_TAIL_MS, (s.endMs - s.startMs) * 0.15);
      spread(own, s.startMs, s.endMs - tail, times);
    });
  } else if (segments.length > 0) {
    // The words don't line up with the segments (an edited line, odd markup): use the spoken span.
    spread(pieces, segments[0]!.startMs, segments[segments.length - 1]!.endMs, times);
  } else {
    const d = Math.max(0, audio.durationMs);
    const lead = Math.min(LEAD_MS, d * 0.04);
    spread(pieces, lead, d - tailOf(d), times);
  }

  // Back from pieces to printed words; unsaid words sit at the end of the word before them.
  const out: WordTime[] = [];
  let p = 0;
  let lastEnd = 0;
  tokens.forEach((t, i) => {
    if (!t.pieces.length) {
      out.push({ startMs: lastEnd, endMs: lastEnd, spoken: false });
      return;
    }
    const first = times[p]!;
    while (p < pieces.length && pieces[p]!.token === i) p++;
    const last = times[p - 1]!;
    lastEnd = last.endMs;
    out.push({ startMs: first.startMs, endMs: last.endMs, spoken: true });
  });
  return out;
}

/**
 * The word being said at `ms`: the last said word that has started, or -1 before the first.
 * Words nobody says are passed over.
 */
export function wordAt(times: WordTime[], ms: number): number {
  let current = -1;
  for (let i = 0; i < times.length; i++) {
    const t = times[i]!;
    if (!t.spoken) continue;
    if (t.startMs <= ms) current = i;
    else break;
  }
  return current;
}

/** A piece that ends a sentence: a full stop, ? or !, with any closing quote or bracket after. */
const SENTENCE_END = /[.!?…]["'’”)\]]*$/;

/**
 * The last sentence of a line, as character offsets into its text: what an actor hears as their
 * cue. It starts after the last sentence end before the line's final words and runs to the last
 * word the character says; [directions] at the end are left out. Null for a line with no words.
 */
export function cueRange(text: string): { start: number; end: number } | null {
  const tokens = lineTokens(text);
  const said = tokens.filter((t) => !t.narrator && t.pieces.length > 0);
  if (!said.length) return null;
  let first = said.length - 1;
  while (first > 0 && !SENTENCE_END.test(said[first - 1]!.pieces[said[first - 1]!.pieces.length - 1]!)) first--;
  return { start: said[first]!.start, end: said[said.length - 1]!.end };
}
