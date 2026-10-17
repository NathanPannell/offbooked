import type { SttResult, WordOp } from "../api/types";

// Scoring follows docs/on-device-stt.md: unbiased recognition, tolerant comparison.

/**
 * Verdicts judge whether the line was said, not how exactly: a misheard word counts as attempted,
 * because phone audio and a tiny model mishear even a perfect take. Share of the line's words
 * attempted (matched or misheard) that counts as the whole line.
 */
export const COMPLETE_COVERAGE = 0.7;
/** Lines with this many words or fewer are judged by missing-word count: one missing word is still complete. */
export const SHORT_LINE_WORDS = 3;

const ONES = [
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
  "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen",
];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

/** Spells out 0..999,999. Larger numbers are returned as digits. */
export function numberToWords(n: number): string {
  if (!Number.isInteger(n) || n < 0 || n >= 1_000_000) return String(n);
  if (n < 20) return ONES[n];
  if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? " " + ONES[n % 10] : "");
  if (n < 1000) {
    const rest = n % 100;
    return ONES[Math.floor(n / 100)] + " hundred" + (rest ? " " + numberToWords(rest) : "");
  }
  const rest = n % 1000;
  return numberToWords(Math.floor(n / 1000)) + " thousand" + (rest ? " " + numberToWords(rest) : "");
}

/** Years read the way people say them: 1984 is "nineteen eighty four", 1600 "sixteen hundred". */
function yearToWords(n: number): string {
  const hi = Math.floor(n / 100);
  const lo = n % 100;
  if (lo === 0) return numberToWords(hi) + " hundred";
  return numberToWords(hi) + " " + (lo < 10 ? "oh " + ONES[lo] : numberToWords(lo));
}

const ORDINAL_WORDS: Record<string, string> = {
  one: "first", two: "second", three: "third", five: "fifth", eight: "eighth", nine: "ninth", twelve: "twelfth",
};

function ordinalToWords(n: number): string {
  const words = numberToWords(n).split(" ");
  const last = words.pop()!;
  const ordinal = ORDINAL_WORDS[last] ?? (last.endsWith("y") ? last.slice(0, -1) + "ieth" : last + "th");
  return [...words, ordinal].join(" ");
}

function digitsToWords(token: string): string {
  const n = Number(token);
  if ((n >= 1100 && n <= 1999) || (n >= 2010 && n <= 2099)) return yearToWords(n);
  return numberToWords(n);
}

const WHOLE_WORDS: Record<string, string> = {
  "won't": "will not",
  "can't": "can not",
  cannot: "can not",
  "shan't": "shall not",
  "let's": "let us",
  "'tis": "it is",
  "'twas": "it was",
  "'twill": "it will",
  "o'er": "over",
  "e'en": "even",
  "ne'er": "never",
  "e'er": "ever",
  "'em": "them",
  "y'all": "you all",
  gonna: "going to",
  wanna: "want to",
  mr: "mister",
  mrs: "missus",
  dr: "doctor",
};

const IS_CONTRACTIONS = new Set(["it", "he", "she", "that", "what", "there", "here", "where", "who", "how"]);

const SUFFIXES: [string, string][] = [
  ["n't", " not"],
  ["'re", " are"],
  ["'ve", " have"],
  ["'ll", " will"],
  ["'m", " am"],
  ["'d", " would"],
];

export const FILLERS = new Set(["um", "uh", "er", "erm", "ah", "hmm", "mm", "mhm"]);

function expandToken(raw: string): string[] {
  if (WHOLE_WORDS[raw]) return WHOLE_WORDS[raw].split(" ");
  const token = raw.replace(/^'+|'+$/g, "");
  if (!token) return [];
  if (WHOLE_WORDS[token]) return WHOLE_WORDS[token].split(" ");
  if (/^\d+$/.test(token)) return digitsToWords(token).split(" ");
  const ordinal = /^(\d+)(st|nd|rd|th)$/.exec(token);
  if (ordinal) return ordinalToWords(Number(ordinal[1])).split(" ");
  for (const [suffix, expansion] of SUFFIXES) {
    if (token.endsWith(suffix) && token.length > suffix.length) {
      return (token.slice(0, -suffix.length) + expansion).split(" ");
    }
  }
  if (token.endsWith("'s")) {
    const stem = token.slice(0, -2);
    if (IS_CONTRACTIONS.has(stem)) return [stem, "is"];
  }
  // Possessives and other apostrophes compare without the apostrophe ("Hamlet's" = "Hamlets").
  return [token.replace(/'/g, "")];
}

/** The words of a line as written, after splitting on spaces and dashes. */
export function displayWords(text: string): string[] {
  return text
    .normalize("NFKC")
    .replace(/[‐-―−…/-]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

export function normalizeDisplayWord(word: string): string[] {
  const cleaned = word
    .toLowerCase()
    .replace(/[‘’ʼ′`]/g, "'")
    .replace(/&/g, " and ")
    .replace(/%/g, " percent ")
    .replace(/[^\p{L}\p{N}']+/gu, " ");
  return cleaned.split(/\s+/).filter(Boolean).flatMap(expandToken);
}

/** Normalized comparison words, each tagged with the index of the written word it came from. */
export function tokenize(text: string): { word: string; display: number }[] {
  return displayWords(text).flatMap((w, display) => normalizeDisplayWord(w).map((word) => ({ word, display })));
}

export function normalizeWords(text: string): string[] {
  return tokenize(text).map((t) => t.word);
}

/** Drops non-speech markers ("[BLANK_AUDIO]", "(music)") and collapses a looping tail. */
export function cleanTranscript(text: string): string {
  const words = text
    .replace(/\[[^\]]*\]|\([^)]*\)|\*[^*]*\*|[♪♫]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  return collapseRepeatedTail(words).join(" ");
}

/** Models can loop near their token cap ("my lord my lord my lord"). Keep one copy of a 3+ times repeated tail. */
function collapseRepeatedTail(words: string[]): string[] {
  const key = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}']/gu, "");
  for (let size = 1; size <= 6; size++) {
    let repeats = 1;
    while ((repeats + 1) * size <= words.length) {
      const a = words.slice(words.length - size).map(key).join(" ");
      const start = words.length - (repeats + 1) * size;
      const b = words.slice(start, start + size).map(key).join(" ");
      if (a !== b) break;
      repeats++;
    }
    if (repeats >= 3) return words.slice(0, words.length - (repeats - 1) * size);
  }
  return words;
}

/** Optimal string alignment distance (Levenshtein plus adjacent transpositions). */
export function osaDistance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array<number>(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[a.length][b.length];
}

/** Long words that are one letter off (two for 9+ letters) count as said: ASR misspells names and rare words. */
export function isNearMatch(a: string, b: string): boolean {
  if (a === b) return true;
  const longest = Math.max(a.length, b.length);
  if (longest < 6) return false;
  return osaDistance(a, b) <= (longest >= 9 ? 2 : 1);
}

type Step = "diag" | "del" | "ins" | "merge21" | "merge12";

/**
 * Word-level alignment with near matches and compound merges ("to morrow" = "tomorrow").
 * Ops for expected words come out in order, one per normalized expected word, so they map
 * back onto the written line. Ties prefer, in reading order: a match, then a missed word,
 * then an extra word.
 */
export function alignWords(expected: string[], heard: string[]): WordOp[] {
  // Align the reversed sequences so the backtrace walks the line forwards.
  const e = [...expected].reverse();
  const h = [...heard].reverse();
  const n = e.length;
  const m = h.length;
  const cost: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(Infinity));
  const hits: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  cost[0][0] = 0;

  const relax = (i: number, j: number, c: number, k: number) => {
    if (c < cost[i][j] || (c === cost[i][j] && k > hits[i][j])) {
      cost[i][j] = c;
      hits[i][j] = k;
    }
  };
  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= m; j++) {
      if (i > 0 && j > 0) {
        const near = isNearMatch(e[i - 1], h[j - 1]);
        relax(i, j, cost[i - 1][j - 1] + (near ? 0 : 1), hits[i - 1][j - 1] + (near ? 1 : 0));
      }
      if (i > 1 && j > 0 && e[i - 1] + e[i - 2] === h[j - 1]) relax(i, j, cost[i - 2][j - 1], hits[i - 2][j - 1] + 2);
      if (i > 0 && j > 1 && h[j - 1] + h[j - 2] === e[i - 1]) relax(i, j, cost[i - 1][j - 2], hits[i - 1][j - 2] + 1);
      if (i > 0) relax(i, j, cost[i - 1][j] + 1, hits[i - 1][j]);
      if (j > 0) relax(i, j, cost[i][j - 1] + 1, hits[i][j - 1]);
    }
  }

  const stepFits = (step: Step, i: number, j: number): boolean => {
    switch (step) {
      case "diag": {
        if (i === 0 || j === 0) return false;
        const near = isNearMatch(e[i - 1], h[j - 1]);
        return cost[i][j] === cost[i - 1][j - 1] + (near ? 0 : 1) && hits[i][j] === hits[i - 1][j - 1] + (near ? 1 : 0);
      }
      case "merge21":
        return i > 1 && j > 0 && e[i - 1] + e[i - 2] === h[j - 1] && cost[i][j] === cost[i - 2][j - 1] && hits[i][j] === hits[i - 2][j - 1] + 2;
      case "merge12":
        return i > 0 && j > 1 && h[j - 1] + h[j - 2] === e[i - 1] && cost[i][j] === cost[i - 1][j - 2] && hits[i][j] === hits[i - 1][j - 2] + 1;
      case "del":
        return i > 0 && cost[i][j] === cost[i - 1][j] + 1 && hits[i][j] === hits[i - 1][j];
      case "ins":
        return j > 0 && cost[i][j] === cost[i][j - 1] + 1 && hits[i][j] === hits[i][j - 1];
    }
  };

  const ops: WordOp[] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    const step = (["merge21", "merge12", "diag", "del", "ins"] as Step[]).find((s) => stepFits(s, i, j));
    if (step === "merge21") {
      ops.push({ op: "ok", expected: e[i - 1], heard: h[j - 1] }, { op: "ok", expected: e[i - 2], heard: h[j - 1] });
      i -= 2;
      j -= 1;
    } else if (step === "merge12") {
      ops.push({ op: "ok", expected: e[i - 1], heard: `${h[j - 1]} ${h[j - 2]}` });
      i -= 1;
      j -= 2;
    } else if (step === "diag") {
      ops.push({ op: isNearMatch(e[i - 1], h[j - 1]) ? "ok" : "sub", expected: e[i - 1], heard: h[j - 1] });
      i--;
      j--;
    } else if (step === "del") {
      ops.push({ op: "del", expected: e[i - 1] });
      i--;
    } else {
      ops.push({ op: "ins", heard: h[j - 1] });
      j--;
    }
  }
  return ops;
}

export function errorCount(ops: WordOp[]): number {
  return ops.filter((o) => o.op !== "ok").length;
}

/** accuracy = max(0, 1 − (S + D + I) / N), where N is the number of expected words. */
export function accuracyFromOps(ops: WordOp[]): number {
  const expectedCount = ops.filter((o) => o.op !== "ins").length;
  const errors = errorCount(ops);
  if (expectedCount === 0) return errors === 0 ? 1 : 0;
  return Math.max(0, 1 - errors / expectedCount);
}

export function scoreLine(expectedText: string, transcript: string): SttResult {
  const heardText = cleanTranscript(transcript);
  const expected = normalizeWords(expectedText);
  let heard = normalizeWords(heardText);
  const expectedSet = new Set(expected);
  heard = heard.filter((w) => !FILLERS.has(w) || expectedSet.has(w));
  const ops = alignWords(expected, heard);
  return { transcript: heardText, accuracy: Math.round(accuracyFromOps(ops) * 1000) / 1000, ops };
}

/** The result for a take where the silence gate found no speech. */
export function noSpeechResult(expectedText: string): SttResult {
  return { transcript: "", accuracy: 0, ops: normalizeWords(expectedText).map((w) => ({ op: "del", expected: w })) };
}

/** complete: the line was said. partial: a real chunk is missing. unattempted: nothing of it was heard. */
export type Verdict = "complete" | "partial" | "unattempted";

/** Expected words in the ops, and how many of them were attempted (matched or misheard). */
export function coverage(ops: WordOp[]): { expected: number; attempted: number; matched: number } {
  let expected = 0;
  let attempted = 0;
  let matched = 0;
  for (const o of ops) {
    if (o.op === "ins") continue;
    expected++;
    if (o.op === "ok") matched++;
    if (o.op !== "del") attempted++;
  }
  return { expected, attempted, matched };
}

export function verdict(result: Pick<SttResult, "ops" | "transcript">): Verdict {
  const { expected, attempted, matched } = coverage(result.ops);
  if (!result.transcript) return "unattempted";
  if (expected === 0) return "complete";
  if (attempted === 0) return "unattempted";
  if (expected <= SHORT_LINE_WORDS) return attempted >= expected - 1 ? "complete" : "partial";
  // Words heard but none of them the line's: something else was said.
  if (matched === 0) return "unattempted";
  return attempted >= COMPLETE_COVERAGE * expected ? "complete" : "partial";
}

export const VERDICT_LABEL: Record<Verdict, string> = {
  complete: "Complete",
  partial: "Partial",
  unattempted: "Not attempted",
};

export const VERDICT_MESSAGE: Record<Verdict, string> = {
  complete: "Sounds like the whole line.",
  partial: "Part of the line seems missing. Listen back or record again.",
  unattempted: "We couldn't hear this line. Listen back or record again.",
};

/** Short chip label: Complete, Partial or Not attempted. */
export function scoreLabel(result: Pick<SttResult, "ops" | "transcript">): string {
  return VERDICT_LABEL[verdict(result)];
}

/** Sort order for review lists: the lines most worth another take first. */
export const VERDICT_RANK: Record<Verdict, number> = { unattempted: 0, partial: 1, complete: 2 };

export type VerdictCounts = Record<Verdict, number>;

export function verdictCounts(results: Pick<SttResult, "ops" | "transcript">[]): VerdictCounts {
  const counts: VerdictCounts = { complete: 0, partial: 0, unattempted: 0 };
  for (const r of results) counts[verdict(r)]++;
  return counts;
}

/** "12 complete · 2 partial · 1 not attempted", leaving out zeros. */
export function formatVerdictCounts(counts: VerdictCounts): string {
  return (["complete", "partial", "unattempted"] as Verdict[])
    .filter((v) => counts[v] > 0)
    .map((v) => `${counts[v]} ${VERDICT_LABEL[v].toLowerCase()}`)
    .join(" · ");
}

/** Micro-averaged accuracy over several lines: 1 − ΣE / ΣN. */
export function overallAccuracy(results: Pick<SttResult, "ops">[]): number | null {
  let errors = 0;
  let words = 0;
  for (const r of results) {
    errors += errorCount(r.ops);
    words += r.ops.filter((o) => o.op !== "ins").length;
  }
  if (words === 0) return null;
  return Math.max(0, 1 - errors / words);
}

export interface AnnotatedWord {
  text: string;
  state: "ok" | "missed" | "changed";
  heard?: string;
  /** Extra words heard right after this written word. */
  extra: string[];
}

/**
 * Maps word ops back onto the line as written, so highlights land on the script's own words.
 * Returns null when the ops don't fit the text (for example, the line was edited since).
 */
export function annotateLine(text: string, ops: WordOp[]): { leading: string[]; words: AnnotatedWord[] } | null {
  const written = displayWords(text);
  const tokens = tokenize(text);
  const words: AnnotatedWord[] = written.map((w) => ({ text: w, state: "ok", extra: [] }));
  const leading: string[] = [];
  let t = 0;
  for (const op of ops) {
    if (op.op === "ins") {
      const at = t === 0 ? -1 : tokens[t - 1].display;
      if (at < 0) leading.push(op.heard ?? "");
      else words[at].extra.push(op.heard ?? "");
      continue;
    }
    const token = tokens[t++];
    if (!token || token.word !== op.expected) return null;
    const word = words[token.display];
    if (op.op === "del" && word.state === "ok") word.state = "missed";
    if (op.op === "sub") {
      word.state = "changed";
      word.heard = word.heard ? `${word.heard} ${op.heard}` : op.heard;
    }
  }
  return t === tokens.length ? { leading, words } : null;
}

export function formatAccuracy(accuracy: number): string {
  return `${Math.round(accuracy * 100)}%`;
}
