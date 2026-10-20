// Live word highlighting and auto-advance while a line is being recorded.
// Everything here is pure: the recording screen feeds it transcripts and mic levels.

import { cleanTranscript, displayWords, FILLERS, isNearMatch, normalizeDisplayWord, normalizeWords } from "./score";

/** A run of the line as written. Whitespace and [directions] are kept verbatim so the text renders unchanged. */
export interface LinePiece {
  kind: "word" | "space" | "direction";
  text: string;
  /** Comparison tokens this piece covers: [tokenStart, tokenEnd). Spaces and directions cover none. */
  tokenStart: number;
  tokenEnd: number;
}

export interface LineWords {
  pieces: LinePiece[];
  /** Normalized words that must be spoken, in order. [Bracketed] directions are left out. */
  tokens: string[];
}

/** Splits a line into renderable pieces and the words to listen for. An unclosed "[" runs to the end. */
export function segmentLine(text: string): LineWords {
  const raw: { kind: LinePiece["kind"]; text: string }[] = [];
  const pattern = /\[[^\]]*\]?|\s+|[^\s[]+/g;
  for (const match of text.matchAll(pattern)) {
    const part = match[0];
    raw.push({ kind: part.startsWith("[") ? "direction" : /^\s+$/.test(part) ? "space" : "word", text: part });
  }
  // A (parenthesised) direction that opens or closes the line isn't said either.
  const words = raw.flatMap((p, i) => (p.kind === "word" ? [i] : []));
  if (words.length && raw[words[0]!]!.text.startsWith("(")) {
    const end = words.findIndex((i) => raw[i]!.text.includes(")"));
    if (end >= 0) for (const i of words.slice(0, end + 1)) raw[i]!.kind = "direction";
  }
  const lastWord = words[words.length - 1];
  if (lastWord !== undefined && raw[lastWord]!.kind === "word" && raw[lastWord]!.text.endsWith(")")) {
    let k = words.length - 1;
    while (k > 0 && !raw[words[k]!]!.text.startsWith("(")) k--;
    if (raw[words[k]!]!.text.startsWith("(")) for (const i of words.slice(k)) raw[i]!.kind = "direction";
  }
  const pieces: LinePiece[] = [];
  const tokens: string[] = [];
  for (const p of raw) {
    const at = tokens.length;
    if (p.kind === "word") for (const w of displayWords(p.text)) tokens.push(...normalizeDisplayWord(w));
    pieces.push({ kind: p.kind, text: p.text, tokenStart: at, tokenEnd: tokens.length });
  }
  return { pieces, tokens };
}

export type PieceState = "lit" | "next" | "ahead" | "direction" | "space";

/** How each piece shows for a "spoken up to token N" cursor. */
export function pieceStates(pieces: LinePiece[], cursor: number): PieceState[] {
  let nextGiven = false;
  return pieces.map((p) => {
    if (p.kind !== "word") return p.kind;
    const lit = p.tokenEnd > p.tokenStart ? p.tokenEnd <= cursor : cursor > 0 && p.tokenStart <= cursor;
    if (lit) return "lit";
    if (!nextGiven && p.tokenEnd > p.tokenStart) {
      nextGiven = true;
      return "next";
    }
    return "ahead";
  });
}

/** Normalized words of a (partial) transcript, without non-speech markers or fillers the line doesn't use. */
export function heardWords(transcript: string, expected: readonly string[]): string[] {
  const expectedSet = new Set(expected);
  return normalizeWords(cleanTranscript(transcript)).filter((w) => !FILLERS.has(w) || expectedSet.has(w));
}

// Alignment scores. A match earns more than a skip costs, so the cursor follows the speaker through
// skipped and misheard words, but one stray match can't jump it far ahead: skipping k words to reach
// a match needs about 1.5 × k matched words to pay for it.
const OK = 2;
const SUB = -1;
const DEL = -2;
const INS = -1;
const TRAIL_INS = -2;

type Move = "start" | "ok" | "sub" | "del" | "ins" | "merge21" | "merge12";

export interface LiveAlignment {
  /** Expected token indices the transcript matched, in order. */
  matched: number[];
  score: number;
}

/**
 * Aligns a partial transcript with the start of a line. The transcript may begin anywhere from
 * `anchor` up to `freeUntil` (free: those words are already lit, or the audio window starts later)
 * and may end anywhere (the rest of the line isn't spoken yet). Skips, misheard words, extra words,
 * repeats and compound splits ("to morrow" = "tomorrow") are tolerated.
 */
export function alignPartial(expected: readonly string[], heard: readonly string[], anchor = 0, freeUntil = 0): LiveAlignment {
  const a = Math.max(0, Math.min(anchor, expected.length));
  const free = Math.max(a, Math.min(freeUntil, expected.length));
  const rows = expected.length - a + 1;
  const m = heard.length;
  const score: number[][] = Array.from({ length: rows }, () => new Array<number>(m + 1).fill(-Infinity));
  const move: Move[][] = Array.from({ length: rows }, () => new Array<Move>(m + 1).fill("start"));

  for (let r = 0; r < rows; r++) {
    const i = a + r;
    for (let j = 0; j <= m; j++) {
      let best = j === 0 ? (i <= free ? 0 : DEL * (i - free)) : -Infinity;
      let how: Move = "start";
      const offer = (value: number, m2: Move) => {
        if (value > best) {
          best = value;
          how = m2;
        }
      };
      if (r > 0 && j > 0) {
        const near = isNearMatch(expected[i - 1], heard[j - 1]);
        offer(score[r - 1][j - 1] + (near ? OK : SUB), near ? "ok" : "sub");
      }
      if (r > 1 && j > 0 && expected[i - 2] + expected[i - 1] === heard[j - 1]) offer(score[r - 2][j - 1] + 2 * OK, "merge21");
      if (r > 0 && j > 1 && heard[j - 2] + heard[j - 1] === expected[i - 1]) offer(score[r - 1][j - 2] + OK, "merge12");
      if (j > 0) offer(score[r][j - 1] + INS, "ins");
      if (r > 0) offer(score[r - 1][j] + DEL, "del");
      score[r][j] = best;
      move[r][j] = how;
    }
  }

  // Free end: the rest of the line is simply not spoken yet. Heard words after the last aligned one
  // cost more than other extra words, because the newest words should explain where the speaker is.
  // Ties keep the earlier position.
  let endR = 0;
  let endJ = 0;
  let endScore = -Infinity;
  for (let r = 0; r < rows; r++) {
    for (let j = 0; j <= m; j++) {
      if (j > 0 && move[r][j] === "ins") continue;
      const value = score[r][j] + TRAIL_INS * (m - j);
      if (value > endScore) {
        endScore = value;
        endR = r;
        endJ = j;
      }
    }
  }

  const matched: number[] = [];
  let r = endR;
  let j = endJ;
  while (j > 0) {
    const step = move[r][j];
    const i = a + r;
    if (step === "ok") {
      matched.push(i - 1);
      r--;
      j--;
    } else if (step === "sub") {
      r--;
      j--;
    } else if (step === "merge21") {
      matched.push(i - 1, i - 2);
      r -= 2;
      j--;
    } else if (step === "merge12") {
      matched.push(i - 1);
      r--;
      j -= 2;
    } else if (step === "del") r--;
    else j--;
  }
  return { matched: matched.reverse(), score: endScore };
}

export interface LiveProgress {
  /** Tokens [0, cursor) count as spoken. Never moves back within a take. */
  cursor: number;
  /** Tokens matched in any pass so far. */
  matched: boolean[];
}

export function startProgress(tokenCount: number): LiveProgress {
  return { cursor: 0, matched: new Array<boolean>(tokenCount).fill(false) };
}

/** How far back from the cursor a windowed transcript (the last few seconds only) may start. */
export const WINDOW_BACK_TOKENS = 12;

/**
 * Folds one transcription pass into the progress. `windowed` means the transcript covers only the
 * last few seconds of the take, so it may start mid-line near the cursor.
 */
export function applyPass(progress: LiveProgress, tokens: readonly string[], transcript: string, windowed = false): LiveProgress {
  const heard = heardWords(transcript, tokens);
  if (heard.length === 0 || tokens.length === 0) return progress;
  const anchor = windowed ? Math.max(0, progress.cursor - WINDOW_BACK_TOKENS) : 0;
  const { matched } = alignPartial(tokens, heard, anchor, progress.cursor);
  if (matched.length === 0) return progress;
  const next = progress.matched.slice();
  for (const i of matched) next[i] = true;
  const cursor = Math.max(progress.cursor, matched[matched.length - 1] + 1);
  return { cursor, matched: next };
}

export function matchedCount(progress: LiveProgress): number {
  return progress.matched.filter(Boolean).length;
}

// ---------------------------------------------------------------------------------------------
// Voice activity: a simple energy detector with an adaptive noise floor.

export interface VadState {
  /** Estimated background level in dBFS, or null before the first frame. */
  floor: number | null;
  speechMs: number;
  /** Silence since the last speech, or since the start when nothing has been said. */
  silenceMs: number;
  /** Consecutive voiced time, so a click doesn't count as speech. */
  runMs: number;
  /** Take time when speech last ended (or is ongoing). */
  lastSpeechAtMs: number;
  elapsedMs: number;
}

export const VAD_FLOOR_DB = -50;
const VAD_ABOVE_FLOOR_DB = 12;
/** Voiced this long without a break, sound counts as speech (a click doesn't). */
export const VAD_MIN_RUN_MS = 60;
const VAD_FLOOR_RISE_DB_PER_S = 3;

export function startVad(): VadState {
  return { floor: null, speechMs: 0, silenceMs: 0, runMs: 0, lastSpeechAtMs: 0, elapsedMs: 0 };
}

/** Folds one frame's RMS level (dBFS) into the detector. */
export function vadStep(state: VadState, db: number, frameMs: number): VadState {
  let floor = state.floor ?? Math.min(db, -30);
  if (db < floor) floor = floor * 0.6 + db * 0.4;
  else floor = Math.min(db, floor + (VAD_FLOOR_RISE_DB_PER_S * frameMs) / 1000);
  floor = Math.min(floor, -30);
  const voiced = db > Math.max(VAD_FLOOR_DB, floor + VAD_ABOVE_FLOOR_DB);
  const elapsedMs = state.elapsedMs + frameMs;
  const runMs = voiced ? state.runMs + frameMs : 0;
  const speaking = runMs >= VAD_MIN_RUN_MS;
  return {
    floor,
    speechMs: state.speechMs + (speaking ? frameMs : 0),
    silenceMs: speaking ? 0 : voiced ? state.silenceMs : state.silenceMs + frameMs,
    runMs,
    lastSpeechAtMs: speaking ? elapsedMs : state.lastSpeechAtMs,
    elapsedMs,
  };
}

/** RMS level of a block of samples in dBFS. */
export function rmsDb(samples: Float32Array, start = 0, end = samples.length): number {
  let sum = 0;
  for (let i = start; i < end; i++) sum += samples[i] * samples[i];
  const rms = Math.sqrt(sum / Math.max(1, end - start));
  return rms > 0 ? 20 * Math.log10(rms) : -120;
}

// ---------------------------------------------------------------------------------------------
// When to stop a take by itself. A take with real speech always ends after a pause and moves on,
// so it never records forever, but how much of the line has been said never comes from how long
// the actor has spoken: only the words heard say the line is done. Until they do, the pause that
// ends the take is long, so a slow reading, a pause for effect or a transcript running behind is
// never cut off.

/** Words left after the cursor that still count as the end of the line (the last word is often missed). */
export const END_WORDS = 1;
/** Pause that ends a take once the cursor is at (or a word from) the end of the line. */
export const END_SILENCE_MS = 1200;
/** Pause that ends a take whose words weren't heard, or whose transcript lags: long, rather than guessing. */
export const LONG_SILENCE_MS = 2500;
/** Pause that ends a take whose cursor is clearly mid-line: the actor may be pausing for effect. */
export const MID_LINE_SILENCE_MS = 3000;
/** Without a transcript: only a long pause after real speech ends the take. */
export const ENERGY_SILENCE_MS = 2500;
/** Voiced time per word in an average reading of a line (the VAD leaves out the gaps between words). */
export const SPEECH_MS_PER_WORD = 300;
const MIN_SPEECH_MS = 300;
const ENERGY_MIN_SPEECH_MS = 400;
/** Heard words account for the speech when it is at most this much voiced time per word up to the cursor. */
const TRACKED_MS_PER_WORD = SPEECH_MS_PER_WORD * 1.5;

export interface AdvanceInput {
  /** `live` while transcription runs; `energy` when only the mic level is known. */
  mode: "live" | "energy";
  totalTokens: number;
  cursor: number;
  speechMs: number;
  silenceMs: number;
  /** The newest finished transcription covers the audio up to the end of the last speech. */
  caughtUp: boolean;
}

/** wait: keep recording. advance: stop, keep the take, go to the next line. */
export type AdvanceDecision = "wait" | "advance";

/** The pause that ends this take now, or null before any real speech. */
export function endPauseMs(input: AdvanceInput): number | null {
  const { mode, totalTokens, cursor, speechMs, caughtUp } = input;
  if (mode === "energy") return speechMs < ENERGY_MIN_SPEECH_MS ? null : ENERGY_SILENCE_MS;
  if (speechMs < MIN_SPEECH_MS) return null;
  if (totalTokens - cursor <= END_WORDS) return END_SILENCE_MS;
  // Clearly mid-line: the transcript is current and the words heard explain the speech so far, so
  // the actor is pausing inside the line. Otherwise the words were missed or the transcript lags:
  // wait a long pause rather than guess from speech time.
  const midLine = caughtUp && speechMs <= cursor * TRACKED_MS_PER_WORD;
  return midLine ? MID_LINE_SILENCE_MS : LONG_SILENCE_MS;
}

export function decideAdvance(input: AdvanceInput): AdvanceDecision {
  const pause = endPauseMs(input);
  return pause !== null && input.silenceMs >= pause ? "advance" : "wait";
}

// ---------------------------------------------------------------------------------------------
// Pacing of transcription passes on slow devices.

export const MIN_PASS_INTERVAL_MS = 350;
export const MAX_PASS_INTERVAL_MS = 2000;

/** Waits longer between passes when a pass is slow, so the phone stays responsive. */
export function nextPassInterval(latencyMs: number): number {
  return Math.round(Math.min(MAX_PASS_INTERVAL_MS, Math.max(MIN_PASS_INTERVAL_MS, latencyMs * 1.25 + 120)));
}

/**
 * Seconds of audio sent per pass: the whole take while short, then only the latest window. A pass
 * costs roughly in proportion to its audio (about 90 ms per second on a desktop CPU), so slow
 * devices send less.
 */
export function passWindowSeconds(latencyMs: number): { full: number; window: number } {
  if (latencyMs > 1500) return { full: 4, window: 4 };
  if (latencyMs > 900) return { full: 6, window: 5 };
  return { full: 10, window: 7 };
}
