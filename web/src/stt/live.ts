// Live word highlighting and auto-advance while a line is being recorded.
// Everything here is pure: the recording screen feeds it transcripts and mic levels.

import { cleanTranscript, displayWords, FILLERS, isNearMatch, normalizeDisplayWord, normalizeWords } from "./score";
import { soundsAlike, soundsLikeJoined } from "./sounds";

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

/**
 * Where the line pauses as written: token counts at which a clause or sentence ends (a word ending
 * in , ; : . ! ? or a dash). A pause there, partway through the line, is a natural beat, not the end.
 */
export function clauseBreaks(text: string): Set<number> {
  const breaks = new Set<number>();
  for (const p of segmentLine(text).pieces) {
    if (p.kind === "word" && p.tokenEnd > p.tokenStart && /[,;:.!?\u2014\u2013-]['"\u2019\u201d)]*$/.test(p.text)) breaks.add(p.tokenEnd);
  }
  return breaks;
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
/** A word that only sounds like the one in the line ("due" for "dew"): nearly as good as a match. */
const SOUND = 1.5;
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
/** How well a heard word stands for a word of the line: spelled alike, sounds alike, or not at all. */
function wordMatch(expected: string | undefined, heard: string | undefined): number {
  if (expected === undefined || heard === undefined) return 0;
  if (isNearMatch(expected, heard)) return OK;
  return soundsAlike(expected, heard) ? SOUND : 0;
}

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
        const near = wordMatch(expected[i - 1], heard[j - 1]);
        offer(score[r - 1][j - 1] + (near || SUB), near ? "ok" : "sub");
      }
      // Two words of the line heard as one ("to morrow", or "lesson" for "less than"), and one heard as two.
      if (r > 1 && j > 0) {
        const joined = expected[i - 2] + expected[i - 1];
        // Spelled as the two together, as much as two matches; only sounding like them, no more than one
        // match, so a word heard exactly never lights the word after it too.
        const near = joined === heard[j - 1] ? 2 * OK : soundsLikeJoined(expected[i - 2]!, expected[i - 1]!, heard[j - 1]!) ? SOUND : 0;
        if (near) offer(score[r - 2][j - 1] + near, "merge21");
      }
      if (r > 0 && j > 1) {
        const joined = heard[j - 2] + heard[j - 1];
        const near = joined === expected[i - 1] ? OK : soundsLikeJoined(heard[j - 2]!, heard[j - 1]!, expected[i - 1]!) ? SOUND : 0;
        if (near) offer(score[r - 1][j - 2] + near, "merge12");
      }
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
  /** The end of the line has been heard: every word, or its last words (`tailHeard`). */
  ended: boolean;
}

export function startProgress(tokenCount: number): LiveProgress {
  return { cursor: 0, matched: new Array<boolean>(tokenCount).fill(false), ended: false };
}

/** The line's last words looked for at the end of what was heard. */
export const TAIL_WORDS = 3;
/** The tail only counts once the cursor has followed this much of the line (a long line's tail can't be its start). */
const TAIL_MIN_SHARE = 0.4;

/**
 * Whether the newest heard words are the end of the line: at least two of its last TAIL_WORDS
 * words, in order, spelled or sounding alike, with the line's last word among the last two heard.
 * So a missed or misheard word in the middle never holds the take open once the actor has said how
 * the line ends. Only words found nowhere earlier in the line count, so the start of the line can't
 * pass for its end ("more than kin" is not "less than kind"; "I know not seems" after "Seems, madam"
 * never counts).
 */
export function tailHeard(tokens: readonly string[], heard: readonly string[]): boolean {
  if (tokens.length < TAIL_WORDS || heard.length < 2) return false;
  const start = tokens.length - TAIL_WORDS;
  const unique = (i: number) => !tokens.slice(0, start).some((t) => wordMatch(t, tokens[i]) > 0) && !tokens.some((t, k) => k !== i && t === tokens[i]);
  const last = tokens.length - 1;
  if (!unique(last)) return false;
  const recent = heard.slice(-(TAIL_WORDS + 1));
  for (let j = recent.length - 1; j >= Math.max(1, recent.length - 2); j--) {
    if (!wordMatch(tokens[last], recent[j])) continue;
    // Another of the line's last words, unique to the tail, heard before it.
    for (let i = last - 1; i >= start; i--) {
      if (unique(i) && recent.slice(0, j).some((h) => wordMatch(tokens[i], h) > 0)) return true;
    }
  }
  return false;
}

/** A heard word moves the cursor on its own when it is the next word, or the one after (one missed). */
export const NEXT_WORDS = 2;
/** Further ahead, up to this many words past the cursor, only with the word after it heard too. */
export const LOOKAHEAD_WORDS = 5;

/**
 * Traces along the line: the cursor moves only when the words heard are the next ones expected.
 * The alignment finds which of the line's words were heard; a match counts when it is the next
 * word (or the one after it), or a little further on when the next match follows close behind it.
 * So a stray word that happens to be in the line further on (the "and" of a cue read aloud) never
 * lights up everything before it.
 */
export function traceCursor(cursor: number, matched: readonly number[]): number {
  let c = cursor;
  matched.forEach((i, k) => {
    if (i < c) return;
    const after = matched[k + 1];
    if (i - c < NEXT_WORDS || (i - c <= LOOKAHEAD_WORDS && after !== undefined && after - i < NEXT_WORDS + 1)) c = i + 1;
  });
  return c;
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
  const next = progress.matched.slice();
  for (const i of matched) next[i] = true;
  let cursor = traceCursor(progress.cursor, matched);
  // The line's last words, heard just now: the line is said, whatever was missed on the way.
  if (cursor < tokens.length && cursor >= tokens.length * TAIL_MIN_SHARE && tailHeard(tokens, heard)) cursor = tokens.length;
  if (cursor === progress.cursor && matched.length === 0) return progress;
  return { cursor, matched: next, ended: progress.ended || cursor >= tokens.length };
}

export function matchedCount(progress: LiveProgress): number {
  return progress.matched.filter(Boolean).length;
}

// ---------------------------------------------------------------------------------------------
// The wrong-line check: was the take this line at all? Lenient on purpose: misspoken, swapped or
// paraphrased words are the line. Only a real flub counts: most of the line never heard, or what
// was heard is clearly a nearby line instead (the cue read aloud, the speaker's next line, the line
// after this one).

/** Under this share of the line's words heard, the take wasn't the line. */
export const FLUB_HEARD_SHARE = 1 / 3;
/** A nearby line heard at least this much (and at least OTHER_MIN_WORDS words of it)... */
export const OTHER_HEARD_SHARE = 0.6;
const OTHER_MIN_WORDS = 3;
/** ...and by this much more than the line itself, was said instead of it... */
export const OTHER_MARGIN = 0.3;
/** ...unless most of the line was heard too (the cue read aloud before the line is fine). */
const LINE_HEARD_SHARE = 0.75;

export interface LineCheck {
  /** Nearby lines, followed through the same passes as the line. */
  others: { tokens: string[]; progress: LiveProgress }[];
  /** The most words any pass heard: a take nothing was heard in can't be judged. */
  mostHeard: number;
}

export function startLineCheck(others: readonly string[]): LineCheck {
  return {
    others: others.flatMap((text) => {
      const { tokens } = segmentLine(text);
      return tokens.length ? [{ tokens, progress: startProgress(tokens.length) }] : [];
    }),
    mostHeard: 0,
  };
}

/** Folds one pass into the check, as `applyPass` does into the line's progress. */
export function checkPass(check: LineCheck, lineTokens: readonly string[], transcript: string, windowed = false): LineCheck {
  return {
    others: check.others.map((o) => ({ ...o, progress: applyPass(o.progress, o.tokens, transcript, windowed) })),
    mostHeard: Math.max(check.mostHeard, heardWords(transcript, lineTokens).length),
  };
}

const heardShare = (progress: LiveProgress) => (progress.matched.length ? matchedCount(progress) / progress.matched.length : 0);

/** Whether the take was a flub, not the line: see the section comment. */
export function flubbed(check: LineCheck, progress: LiveProgress): boolean {
  const tokens = progress.matched.length;
  if (tokens === 0 || check.mostHeard < Math.min(OTHER_MIN_WORDS, tokens)) return false;
  const share = heardShare(progress);
  if (share < FLUB_HEARD_SHARE) return true;
  if (share >= LINE_HEARD_SHARE) return false;
  return check.others.some(
    (o) => matchedCount(o.progress) >= OTHER_MIN_WORDS && heardShare(o.progress) >= OTHER_HEARD_SHARE && heardShare(o.progress) - share >= OTHER_MARGIN,
  );
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
/** Pause that ends a take once the end of the line has been heard: every word, or its last words. */
export const END_SILENCE_MS = 700;
/** Pause that ends a take whose cursor is a word from the end (that word may just have been missed). */
export const NEAR_END_SILENCE_MS = 1000;
/**
 * A transcript running behind (a slow phone) that has followed the line to within this many words
 * of its end counts as at the end once the voice since its audio is what those words take.
 */
export const CATCH_UP_WORDS = 3;
/** The share of those words' voiced time (at the actor's own pace) that must have been heard. */
const CATCH_UP_SHARE = 0.9;
/** Pause that ends a take whose words weren't heard, or whose transcript lags: long, rather than guessing. */
export const LONG_SILENCE_MS = 2500;
/** Pause that ends a take whose cursor is clearly mid-line: the actor may be pausing for effect. */
export const MID_LINE_SILENCE_MS = 3000;
/** Pause that ends a take whose cursor sits at a comma or full stop partway through the line: a natural beat. */
export const BEAT_SILENCE_MS = 4500;
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
  /** The end of the line has been heard (`LiveProgress.ended`). */
  ended?: boolean;
  /** Token counts where the written line has a clause or sentence break (`clauseBreaks`). */
  breaks?: ReadonlySet<number>;
  speechMs: number;
  silenceMs: number;
  /** The newest finished transcription covers the audio up to the end of the last speech. */
  caughtUp: boolean;
  /** Voiced time in the audio the newest finished transcription covered (the actor's pace, so far). */
  coveredSpeechMs?: number;
}

/** wait: keep recording. advance: stop, keep the take, go to the next line. */
export type AdvanceDecision = "wait" | "advance";

/** The pause that ends this take now, or null before any real speech. */
export function endPauseMs(input: AdvanceInput): number | null {
  const { mode, totalTokens, cursor, speechMs, caughtUp, ended = false, breaks, coveredSpeechMs } = input;
  if (mode === "energy") return speechMs < ENERGY_MIN_SPEECH_MS ? null : ENERGY_SILENCE_MS;
  if (speechMs < MIN_SPEECH_MS) return null;
  if (ended || cursor >= totalTokens) return END_SILENCE_MS;
  const left = totalTokens - cursor;
  if (left <= END_WORDS) return NEAR_END_SILENCE_MS;
  // The transcript runs behind, a few words from the end: if the voice since the audio it heard is
  // what those words take at this actor's pace, they've been said. The words heard set the pace and
  // how many are left, so speaking time alone never ends a take.
  if (!caughtUp && coveredSpeechMs !== undefined && cursor > 0 && left <= CATCH_UP_WORDS) {
    const pace = Math.min(600, Math.max(150, coveredSpeechMs / cursor));
    if (speechMs - coveredSpeechMs >= left * pace * CATCH_UP_SHARE) return NEAR_END_SILENCE_MS;
  }
  // The transcript is current and has the actor at a comma or full stop partway through the line
  // (or a word past it: the word after a comma is often heard, or guessed, early): a beat, so the
  // longest wait. Elsewhere, clearly mid-line when the words heard explain the speech so far.
  // Otherwise the words were missed or the transcript lags: wait a long pause rather than guess.
  if (caughtUp && (breaks?.has(cursor) || breaks?.has(cursor - 1))) return BEAT_SILENCE_MS;
  return caughtUp && speechMs <= cursor * TRACKED_MS_PER_WORD ? MID_LINE_SILENCE_MS : LONG_SILENCE_MS;
}

export function decideAdvance(input: AdvanceInput): AdvanceDecision {
  const pause = endPauseMs(input);
  return pause !== null && input.silenceMs >= pause ? "advance" : "wait";
}

/** What `decideAdvance` needs, from the live take's state: the hook and the replay both build it here. */
export function advanceInput(take: {
  mode: AdvanceInput["mode"];
  tokens: number;
  breaks: ReadonlySet<number>;
  progress: LiveProgress;
  vad: VadState;
  /** The audio the newest finished pass covered, in ms of the take. */
  coveredMs: number;
  /** Voiced time in that audio. */
  coveredSpeechMs?: number;
}): AdvanceInput {
  const { mode, tokens, breaks, progress, vad, coveredMs, coveredSpeechMs } = take;
  return {
    mode,
    totalTokens: tokens,
    cursor: progress.cursor,
    ended: progress.ended,
    breaks,
    speechMs: vad.speechMs,
    silenceMs: vad.silenceMs,
    caughtUp: coveredMs >= vad.lastSpeechAtMs,
    coveredSpeechMs,
  };
}

// ---------------------------------------------------------------------------------------------
// Pacing of transcription passes on slow devices.

export const MIN_PASS_INTERVAL_MS = 350;
/**
 * Silence after speech this long starts a pass at once instead of at the next paced one, so the
 * end of the line (or a beat) is transcribed as soon as the voice stops: on a slow phone, whose
 * passes are seconds apart, that is when the transcript is needed most.
 */
export const PAUSE_PASS_MS = 250;

/** Whether the voice has just paused (by PAUSE_PASS_MS) between two VAD states. */
export function pauseBegan(before: VadState, after: VadState): boolean {
  return after.speechMs > 0 && before.silenceMs < PAUSE_PASS_MS && after.silenceMs >= PAUSE_PASS_MS;
}
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
