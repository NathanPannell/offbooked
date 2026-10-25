import { linePieces } from "../taketiming.ts";

// Placing a line's words on a take's audio, on the server, from the recording alone (nothing the
// phone measured). A CTC speech model (model.ts: wav2vec2, English letters) gives, for every 20 ms
// frame, how likely each letter is to be said there. The line's text is known, so this doesn't
// transcribe: it finds where those letters, in order, fit the audio best (forced alignment, a
// Viterbi pass over the letters with a blank between them). The take holds more than the line,
// though: a cue read aloud before it, an "um", a false start, an "Okay." after it. So the line may
// start and end anywhere: before its first letter and after its last, every frame is "something
// else", scored as whatever the model heard best there less a small penalty. The line then lands
// where its letters fit: a restart's first words stay outside it, because forcing the line through
// them costs more than leaving them out. How well each word fits where it landed (how far below the
// model's own best its frames score) says whether the line was found at all: a take of another
// line, or of none, has its letters forced onto sounds the model hears as something else, and is
// left to the loudness cut (trim.ts `speechBounds`). Measured on 157 takes of 39 lines (two voices,
// slow to fast reads, beats, cues, "um"s, restarts, "Okay."s, heavy room noise and echo) and 52 of
// the wrong line or none: 96 of the 97 clean takes and 141 of the 157 found, none of the 52.

export const ALIGN = {
  frameMs: 20, // one frame of the model's output (320 samples at 16 kHz)
  outsidePenalty: 0.05, // per frame outside the line, so silence next to it joins the line's blanks rather than "something else"
  onsetLagMs: 40, // the model hears a word's first letter about this long after its sound starts (measured on the fixtures)
  wordGap: -1.5, // a word fits where it was placed when its frames there score at most this far below the model's best (log-probability per letter)
  minFit: 0.55, // the line is found when at least this share of its said words fit
  maxCells: 60_000_000, // frames × alignment states searched at most (a byte each): about 4 minutes of a 1,500-letter speech
} as const;

/** The model's alphabet (wav2vec2-base-960h's vocab.json): 0 is the CTC blank, 4 the word break, letters from 5. */
export const BLANK = 0;
export const WORD_BREAK = 4;
export const VOCAB_SIZE = 32;
const LETTERS = new Map([..."ETAONIHSRDLUMWCFGYPBVK'XJQZ"].map((c, i) => [c, i + 5]));
const APOSTROPHE = LETTERS.get("'")!;

/** A model's output: log-probabilities, `frames` rows of `vocab` (row-major). */
export interface Emissions {
  frames: number;
  vocab: number;
  logp: Float32Array;
}

const ONES = "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen".split(" ");
const TENS = ",,twenty,thirty,forty,fifty,sixty,seventy,eighty,ninety".split(",");

/** An integer below 10,000 as it is said ("seven", "forty two", "two thousand ten"); null past that. */
export function numberWords(n: number): string | null {
  if (!Number.isInteger(n) || n < 0 || n >= 10_000) return null;
  if (n < 20) return ONES[n]!;
  if (n < 100) return `${TENS[Math.floor(n / 10)]}${n % 10 ? ` ${ONES[n % 10]}` : ""}`;
  if (n < 1000) return `${ONES[Math.floor(n / 100)]} hundred${n % 100 ? ` ${numberWords(n % 100)}` : ""}`;
  return `${ONES[Math.floor(n / 1000)]} thousand${n % 1000 ? ` ${numberWords(n % 1000)}` : ""}`;
}

/** A printed word as the model's letters: accents dropped, "&" as "and", numbers spelled out; [] when nothing in it is said. */
export function wordTokens(word: string): number[] {
  const spelled = word
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[’‘`]/g, "'")
    .replace(/&/g, "and")
    .replace(/æ/gi, "ae")
    .replace(/œ/gi, "oe")
    .replace(/\d+/g, (d) => ` ${numberWords(Number(d)) ?? ""} `)
    .toUpperCase();
  const out = [...spelled].flatMap((c) => LETTERS.get(c) ?? []);
  // An apostrophe only between letters ("don't", "o'er"), not quoting the word ('seems').
  while (out[0] === APOSTROPHE) out.shift();
  while (out[out.length - 1] === APOSTROPHE) out.pop();
  return out;
}

/** Where one word was placed: its first and last letter's frames (end exclusive), and how well it fits there. */
export interface PlacedWord {
  startFrame: number;
  endFrame: number;
  gap: number; // log-probability per letter below what the model heard best there (0: just what it heard)
}

/**
 * The words (each a list of letters; empty ones are skipped) placed on the emissions in order,
 * with the line free to start and end anywhere (see above): one entry per word, null for an empty
 * one. Null when there is nothing to place, fewer frames than letters, or the search would be too
 * big (ALIGN.maxCells).
 */
export function forcedAlign(em: Emissions, words: readonly (readonly number[])[]): (PlacedWord | null)[] | null {
  const toks: number[] = [];
  const wordOf: number[] = [];
  words.forEach((w, i) => w.forEach((t) => (toks.push(t), wordOf.push(i))));
  const L = toks.length;
  const F = em.frames;
  const V = em.vocab;
  // States: 0 before the line, then blank, letter 0, blank, letter 1, …, blank (1…S), then S+1 after it.
  const S = 2 * L + 1;
  const N = S + 2;
  if (!L || F < L || F * N > ALIGN.maxCells) return null;
  const lp = em.logp;
  // The best any token does in each frame: what "something else" scores there.
  const free = new Float32Array(F);
  for (let f = 0; f < F; f++) {
    let m = -Infinity;
    for (let k = 0; k < V; k++) m = Math.max(m, lp[f * V + k]!);
    free[f] = m - ALIGN.outsidePenalty;
  }
  const emit = (f: number, s: number) => {
    if (s === 0 || s === S + 1) return free[f]!;
    // A blank, or the word break the model may hear between words.
    if ((s - 1) % 2 === 0) return Math.max(lp[f * V + BLANK]!, lp[f * V + WORD_BREAK]!);
    return lp[f * V + toks[(s - 2) / 2]!]!;
  };
  // How each state was reached, a byte a cell: 0 from itself, 1 from the state before, 2 from two before, 3 from "before the line".
  const back = new Uint8Array(F * N);
  let prev = new Float64Array(N).fill(-Infinity);
  let cur = new Float64Array(N);
  prev[0] = emit(0, 0);
  prev[1] = emit(0, 1);
  prev[2] = emit(0, 2);
  for (let f = 1; f < F; f++) {
    for (let s = 0; s < N; s++) {
      let best = prev[s]!;
      let how = 0;
      if (s >= 1 && prev[s - 1]! > best) {
        best = prev[s - 1]!;
        how = 1;
      }
      // Skip the blank between two different letters; or, after the line, leave from its last letter.
      const skips = s === S + 1 || (s >= 4 && s <= S && s % 2 === 0 && toks[(s - 2) / 2]! !== toks[(s - 4) / 2]!);
      if (skips && prev[s - 2]! > best) {
        best = prev[s - 2]!;
        how = 2;
      }
      if (s === 2 && prev[0]! > best) {
        best = prev[0]!;
        how = 3;
      }
      cur[s] = best === -Infinity ? -Infinity : best + emit(f, s);
      back[f * N + s] = how;
    }
    [prev, cur] = [cur, prev];
  }
  // The line ends at its last letter or the blank after it, or has ended already.
  let s = S + 1;
  if (prev[S]! > prev[s]!) s = S;
  if (prev[S - 1]! > prev[s]!) s = S - 1;
  if (prev[s] === -Infinity) return null;
  const placed = words.map(() => ({ startFrame: -1, endFrame: -1, gap: 0, letters: 0 }));
  for (let f = F - 1; f >= 0; f--) {
    // How far below the model's own best this frame scores, counted to the word of its letter (a
    // blank: of the letter before it, so speech forced into a blank counts against that word).
    if (s >= 1 && s <= S) placed[wordOf[Math.max(0, Math.floor((s - 2) / 2))]!]!.gap += emit(f, s) - free[f]! - ALIGN.outsidePenalty;
    if (s >= 2 && s <= S && s % 2 === 0) {
      const w = placed[wordOf[(s - 2) / 2]!]!;
      if (w.endFrame < 0) w.endFrame = f + 1;
      w.startFrame = f;
    }
    if (f === 0) break;
    const how = back[f * N + s]!;
    s = how === 3 ? 0 : s - how;
  }
  for (const w of wordOf) placed[w]!.letters++;
  return placed.map((w) => (w.letters ? { startFrame: w.startFrame, endFrame: w.endFrame, gap: w.gap / w.letters } : null));
}

/** A line placed on a take: each piece's start (ms of the audio), the first said word's start and the last's end, and how well it fits. */
export interface LineAlignment {
  wordStartsMs: number[]; // one per piece of the line (`linePieces`), like the player's tokens
  firstMs: number;
  lastEndMs: number;
  fit: number; // share of the said words that fit where they were placed (ALIGN.wordGap)
}

/**
 * The line's words placed on a take (its emissions), however well they fit; null when there is
 * nothing to place. Pieces the actor doesn't say (a [direction], a dash) start with the next said
 * word, or at the end of the last.
 */
export function placeLine(em: Emissions, text: string): LineAlignment | null {
  const pieces = linePieces(text);
  const placed = forcedAlign(
    em,
    pieces.map((p) => (p.narrator ? [] : wordTokens(p.text))),
  );
  const said = placed?.flatMap((p) => (p ? [p] : [])) ?? [];
  if (!placed || !said.length) return null;
  const ms = (frame: number) => Math.max(0, frame * ALIGN.frameMs - ALIGN.onsetLagMs);
  const lastEndMs = said[said.length - 1]!.endFrame * ALIGN.frameMs;
  const starts = new Array<number>(pieces.length);
  let following = lastEndMs;
  for (let i = pieces.length - 1; i >= 0; i--) {
    const p = placed[i];
    starts[i] = p ? ms(p.startFrame) : following;
    following = starts[i]!;
  }
  let floor = 0;
  const wordStartsMs = starts.map((t) => (floor = Math.max(floor, Math.round(t))));
  const fit = said.filter((p) => p.gap >= ALIGN.wordGap).length / said.length;
  return { wordStartsMs, firstMs: ms(said[0]!.startFrame), lastEndMs, fit };
}

/** The line placed on a take when it was found there (ALIGN.minFit); null otherwise: the take is then cut by loudness and served without word starts. */
export function alignLine(em: Emissions, text: string): LineAlignment | null {
  const line = placeLine(em, text);
  return line && line.fit >= ALIGN.minFit ? line : null;
}
