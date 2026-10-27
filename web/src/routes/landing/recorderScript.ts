// The landing page's second demo: Lady Macbeth's lines from the same scene being recorded hands-free.
// Nothing is recorded and nothing is heard: it is a walkthrough of the recorder, timed by the words.
// Each line's words light up as they're "said", the take ends a moment after the last one, and the
// next line starts recording by itself, as the app does with "Keep recording the next line" on.

import { DEMO_LINES, tokenize } from "./demoScript";

export interface RecorderLine {
  /** The castmate's line before it, shown as the cue. */
  cueWho: string;
  cue: string;
  text: string;
}

/** Lady Macbeth's lines in the demo scene, each with the line before it as its cue. */
export const RECORDER_LINES: RecorderLine[] = DEMO_LINES.flatMap((line, i) => {
  const before = DEMO_LINES[i - 1];
  return line.mine && before ? [{ cueWho: before.who, cue: before.text, text: line.text }] : [];
});

/** Before the first word of a take. */
export const LEAD_MS = 450;
/** Each word, on average (a little quicker than reading aloud, so the demo doesn't drag). */
export const WORD_MS = 330;
/** After the last word: the pause the app waits once the end of the line is heard. */
export const END_MS = 700;
/** The beat while the next card moves up before its take starts. */
export const MOVE_MS = 450;

export const wordCount = (text: string) => tokenize(text).filter((t) => t.word).length;

/** How long one line's part of the walkthrough lasts, from its card arriving to the next one's. */
export const lineMs = (line: RecorderLine) => MOVE_MS + LEAD_MS + wordCount(line.text) * WORD_MS + END_MS;

/** The whole walkthrough, every line once. */
export const totalMs = (lines: RecorderLine[] = RECORDER_LINES) => lines.reduce((sum, l) => sum + lineMs(l), 0);

export type RecorderPhase = "moving" | "speaking" | "ending" | "wrapped";

export interface RecorderFrame {
  /** The line being recorded (lines.length once every line is in). */
  index: number;
  phase: RecorderPhase;
  /** Words of the current line heard so far. */
  heard: number;
  /** Lines recorded so far. */
  recorded: number;
}

/** Where the walkthrough is `ms` after it started. */
export function recorderAt(ms: number, lines: RecorderLine[] = RECORDER_LINES): RecorderFrame {
  let at = Math.max(0, ms);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const length = lineMs(line);
    if (at < length) {
      const words = wordCount(line.text);
      if (at < MOVE_MS) return { index, phase: "moving", heard: 0, recorded: index };
      const spoken = at - MOVE_MS - LEAD_MS;
      if (spoken < words * WORD_MS) return { index, phase: "speaking", heard: spoken < 0 ? 0 : Math.floor(spoken / WORD_MS) + 1, recorded: index };
      return { index, phase: "ending", heard: words, recorded: index };
    }
    at -= length;
  }
  return { index: lines.length, phase: "wrapped", heard: 0, recorded: lines.length };
}
