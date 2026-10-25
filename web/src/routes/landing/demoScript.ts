// The landing page demo: a few lines of Macbeth, Act 2 Scene 2 (public domain), as a cast member
// playing Lady Macbeth hears them.
//
// The demo uses no synthesized voices. Until a real cast records the scene it plays silently, timed
// by the words, under a note that says so. To add the recording, put one audio file per line in
// web/public/demo/ (m4a or mp3, trimmed to the speech) and set that line's `audio` to its path, for
// example "/demo/macbeth-2-2-01.m4a". Once every line has its file, the demo plays them and the
// placeholder note goes away. Words light up spread over each clip by their length; for exact
// timing, also give `wordStartsMs` (one start per word of `text`, in ms from the clip's start).

export interface DemoLine {
  who: string;
  text: string;
  /** The castmate whose recording plays for this line. */
  by: string;
  /** The listener's own line (Lady Macbeth): in "Pause, then read" the play waits for them first. */
  mine?: boolean;
  /** A real-cast recording of this line, under web/public/demo/, or null until there is one. */
  audio: string | null;
  wordStartsMs?: number[];
}

export const DEMO_TITLE = "Macbeth · Act 2, Scene 2";
export const DEMO_PART = "LADY MACBETH";

export const DEMO_LINES: DemoLine[] = [
  { who: "MACBETH", by: "Robin", audio: null, text: "I have done the deed. Didst thou not hear a noise?" },
  { who: "LADY MACBETH", by: "Jess", audio: null, mine: true, text: "I heard the owl scream and the crickets cry.\nDid not you speak?" },
  { who: "MACBETH", by: "Robin", audio: null, text: "When?" },
  { who: "LADY MACBETH", by: "Jess", audio: null, mine: true, text: "Now." },
  { who: "MACBETH", by: "Robin", audio: null, text: "As I descended?" },
  { who: "LADY MACBETH", by: "Jess", audio: null, mine: true, text: "Ay." },
  { who: "MACBETH", by: "Robin", audio: null, text: "Hark!\nWho lies i' the second chamber?" },
  { who: "LADY MACBETH", by: "Jess", audio: null, mine: true, text: "Donalbain." },
  { who: "MACBETH", by: "Robin", audio: null, text: "[Looking on his hands] This is a sorry sight." },
  { who: "LADY MACBETH", by: "Jess", audio: null, mine: true, text: "A foolish thought, to say a sorry sight." },
];

/** True once a real-cast recording is in place for every line. */
export const hasRecording = (lines: DemoLine[] = DEMO_LINES) => lines.every((l) => !!l.audio);

export interface DemoToken {
  text: string;
  /** A spoken word (false for spaces, line breaks and [bracketed] directions, which aren't read). */
  word: boolean;
  direction: boolean;
}

/** A line's text in display order: words, the space between them, and [directions] kept whole. */
export function tokenize(text: string): DemoToken[] {
  const tokens: DemoToken[] = [];
  for (const part of text.split(/(\[[^\]]*\]|\s+)/)) {
    if (!part) continue;
    if (part.startsWith("[")) tokens.push({ text: part, word: false, direction: true });
    else tokens.push({ text: part, word: /[\p{L}\p{N}]/u.test(part), direction: false });
  }
  return tokens;
}

/** How long a line takes to say without a recording: about 150 words a minute, at least 0.9 s. */
export function spokenMs(text: string): number {
  const words = tokenize(text).filter((t) => t.word).length;
  return Math.max(900, words * 400 + 300);
}

/**
 * The pause for the listener's own line in "Pause, then read": as long as the line takes to say,
 * plus 15% or half a second, whichever is more (as the app's player times it).
 */
export function pauseMs(lineMs: number): number {
  return Math.round(lineMs + Math.max(lineMs * 0.15, 500));
}

/**
 * When each spoken word starts, in ms, over a clip of `durationMs`: the given starts when there is
 * one per word, else spread by word length after a short lead-in and before a short tail.
 */
export function wordStarts(text: string, durationMs: number, given?: number[]): number[] {
  const words = tokenize(text).filter((t) => t.word);
  if (given && given.length === words.length) return given;
  const lead = Math.min(150, durationMs * 0.05);
  const span = Math.max(0, durationMs - lead - Math.min(200, durationMs * 0.1));
  const weights = words.map((w) => w.text.replace(/[^\p{L}\p{N}]/gu, "").length + 1);
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  const starts: number[] = [];
  let at = lead;
  for (const weight of weights) {
    starts.push(Math.round(at));
    at += (span * weight) / total;
  }
  return starts;
}

/** How many words have started by `ms` (0 before the first, all of them once the last has). */
export function wordsSaid(starts: number[], ms: number): number {
  let n = 0;
  while (n < starts.length && starts[n]! <= ms) n++;
  return n;
}
