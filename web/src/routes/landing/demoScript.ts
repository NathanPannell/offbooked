// A few lines of Hamlet 1.2 (public domain) for the landing page demo.

export interface DemoLine {
  who: string;
  text: string;
  /** How this line is voiced in the demo, as in a real run-through. */
  source: "actor" | "standin" | "tts" | "you";
  /** Shown beside the name: the actor, "stand-in" or "TTS". */
  by: string;
}

export const DEMO_TITLE = "Hamlet · Act 1, Scene 2";

export const DEMO_LINES: DemoLine[] = [
  { who: "Claudius", text: "But now, my cousin Hamlet, and my son—", source: "actor", by: "Sam" },
  { who: "Hamlet", text: "A little more than kin, and less than kind.", source: "you", by: "you" },
  { who: "Claudius", text: "How is it that the clouds still hang on you?", source: "actor", by: "Sam" },
  { who: "Hamlet", text: "Not so, my lord; I am too much in the sun.", source: "you", by: "you" },
  {
    who: "Gertrude",
    text: "Good Hamlet, cast thy nighted colour off,\nAnd let thine eye look like a friend on Denmark.",
    source: "standin",
    by: "stand-in",
  },
  { who: "Hamlet", text: "Ay, madam, it is common.", source: "you", by: "you" },
  { who: "Gertrude", text: "If it be,\nWhy seems it so particular with thee?", source: "tts", by: "TTS" },
  { who: "Hamlet", text: "Seems, madam! nay it is; I know not ‘seems.’", source: "you", by: "you" },
];

/** How long to hold for a line: about 380 ms a word, like the run-through's gaps. */
export function holdMs(text: string): number {
  const words = text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
  return Math.min(8000, Math.max(1400, words * 380 + 700));
}
