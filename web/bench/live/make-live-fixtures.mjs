// Turns spoken lines (one WAV per fixture, from make-live-tts.ps1) into hands-free takes for the
// live-tracking replay: room noise, a breath before the line, the line, then a long quiet tail with
// an exhale and the next line's breath, so the replay can see when each version of the logic would
// end the take. 16 kHz mono WAV, as the live capture hears it, plus fixtures.json with where the
// speech ends and where the line pauses.
// Usage: node bench/live/make-live-fixtures.mjs <spoken dir> <out dir>
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const [, , spokenDir, outDir] = process.argv;
if (!spokenDir || !outDir) throw new Error("Usage: node bench/live/make-live-fixtures.mjs <spoken dir> <out dir>");
mkdirSync(outDir, { recursive: true });

// Lines of Hamlet 1.2 around the fixtures' lines, for the wrong-line check: each line's cue, the
// speaker's next line and the line after this one.
const KIN = "A little more than kin, and less than kind.";
const SUN = "Not so, my lord; I am too much i' the sun.";
const COMMON = "Ay, madam, it is common.";
const SEEMS = "Seems, madam! Nay, it is; I know not 'seems.'";
const OBEY = "I shall in all my best obey you, madam.";
const PARTICULAR = "If it be, Why seems it so particular with thee?";
const FLESH = "O, that this too too solid flesh would melt, Thaw, and resolve itself into a dew!";
const CONTEXT = {
  [KIN]: ["But now, my cousin Hamlet, and my son,—", SUN, "How is it that the clouds still hang on you?"],
  [SUN]: [
    "How is it that the clouds still hang on you?",
    COMMON,
    "Good Hamlet, cast thy nighted colour off, And let thine eye look like a friend on Denmark. Do not for ever with thy vailed lids Seek for thy noble father in the dust: Thou know'st 'tis common; all that lives must die, Passing through nature to eternity.",
  ],
  [COMMON]: [
    "Good Hamlet, cast thy nighted colour off, And let thine eye look like a friend on Denmark. Do not for ever with thy vailed lids Seek for thy noble father in the dust: Thou know'st 'tis common; all that lives must die, Passing through nature to eternity.",
    SEEMS,
    PARTICULAR,
  ],
  [SEEMS]: [PARTICULAR, OBEY, "'Tis sweet and commendable in your nature, Hamlet, To give these mourning duties to your father:"],
  [OBEY]: [
    "Let not thy mother lose her prayers, Hamlet: I pray thee, stay with us; go not to Wittenberg.",
    FLESH,
    "Why, 'tis a loving and a fair reply: Be as ourself in Denmark. Madam, come;",
  ],
  [PARTICULAR]: [COMMON, "Let not thy mother lose her prayers, Hamlet: I pray thee, stay with us; go not to Wittenberg.", SEEMS],
};
/** A take of something other than its line: the wrong-line check should flag it. */
const flub = (text) => ({ text, expect: "flub" });

// Each fixture's line as it is written in the script: what the tracker follows.
const LINES = {
  kin: "A little more than kin, and less than kind.",
  "kin-beat": "A little more than kin, and less than kind.",
  "kin-fast": "A little more than kin, and less than kind.",
  "flesh-beat": "O, that this too too solid flesh would melt, Thaw, and resolve itself into a dew!",
  "seems-beat": "Seems, madam! Nay, it is; I know not 'seems.'",
  "frailty-mumble": "Frailty, thy name is woman!",
  "obey-fast": "I shall in all my best obey you, madam.",
  "sun-slow-beat": "Not so, my lord; I am too much i' the sun.",
  "common-mumble-end": "Ay, madam, it is common.",
  "cloak-long": "'Tis not alone my inky cloak, good mother, Nor customary suits of solemn black, Nor windy suspiration of forced breath,",
  "night-short": "Would the night were come!",
  "think-beat": "Let me not think on't. Frailty, thy name is woman!",
  "particular-paraphrase": "If it be, Why seems it so particular with thee?",
  "dew-beat-noclause": "Thaw, and resolve itself into a dew!",
  "kin-long-beat": "A little more than kin, and less than kind.",
  "seems-long-beat": "Seems, madam! Nay, it is; I know not 'seems.'",
  "sun-long-beat-noclause": "Not so, my lord; I am too much i' the sun.",
  "know-repeat": "I know not 'seems.' 'Tis not alone my inky cloak, good mother,",
  "flesh-fast": "O, that this too too solid flesh would melt, Thaw, and resolve itself into a dew!",
  "kin-cue-then-line": KIN,
  "sun-paraphrase": SUN,
  "obey-paraphrase": OBEY,
  "common-swap": COMMON,
  "kin-paraphrase": KIN,
  "seems-paraphrase": SEEMS,
  "obey-cue-then-line": OBEY,
  "kin-cue-only": flub(KIN),
  "kin-next-line": flub(KIN),
  "common-after-cue": flub(COMMON),
  "obey-nonsense": flub(OBEY),
  "sun-nonsense": flub(SUN),
  "obey-wrong-cue": flub(OBEY),
  "seems-cue-only": flub(SEEMS),
};

const LEAD_S = 0.7;
const TAIL_S = 5.0;
const ffmpeg = (args) => spawnSync("ffmpeg", ["-hide_banner", "-nostdin", "-y", ...args], { encoding: "utf8" });
const breath = (at, len, amp) =>
  `anoisesrc=color=pink:amplitude=${amp}:r=16000:d=${len},highpass=f=300,afade=t=in:d=${len * 0.45},afade=t=out:st=${len * 0.5}:d=${len * 0.5},adelay=${Math.round(at * 1000)}:all=1`;

const out = [];
for (const [id, line] of Object.entries(LINES)) {
  const { text, expect = "line" } = typeof line === "string" ? { text: line } : line;
  const context = CONTEXT[text] ?? [];
  // The line alone, cut to its speech.
  const clean = path.join(outDir, `${id}.clean.wav`);
  ffmpeg([
    "-i",
    path.join(spokenDir, `${id}.wav`),
    "-af",
    "aresample=16000,silenceremove=start_periods=1:start_threshold=-55dB,areverse,silenceremove=start_periods=1:start_threshold=-55dB,areverse,volume=-4dB",
    "-ac",
    "1",
    clean,
  ]);
  const seconds = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", clean]).toString().trim());
  // Pauses inside the line (beats).
  const silences = ffmpeg(["-i", clean, "-af", "silencedetect=noise=-50dB:d=0.35", "-f", "null", "-"]).stderr;
  const starts = [...silences.matchAll(/silence_start: ([\d.]+)/g)].map((m) => Number(m[1]));
  const ends = [...silences.matchAll(/silence_end: ([\d.]+)/g)].map((m) => Number(m[1]));
  const speechEnd = LEAD_S + seconds;
  const beats = starts
    .map((s, i) => [Math.round((LEAD_S + s) * 1000), Math.round((LEAD_S + (ends[i] ?? seconds)) * 1000)])
    .filter(([s, e]) => e - s >= 350 && e < speechEnd * 1000 - 50);
  const total = speechEnd + TAIL_S;
  const graph = [
    `anoisesrc=color=pink:amplitude=0.0035:r=16000:d=${total}[n]`,
    `[0:a]adelay=${LEAD_S * 1000}:all=1[s]`,
    `${breath(LEAD_S - 0.45, 0.4, 0.02)}[b1]`,
    `${breath(speechEnd + 0.3, 0.5, 0.012)}[b2]`,
    `${breath(speechEnd + 2.2, 0.45, 0.02)}[b3]`,
    `[n][s][b1][b2][b3]amix=inputs=5:duration=first:normalize=0[o]`,
  ].join(";");
  ffmpeg(["-i", clean, "-filter_complex", graph, "-map", "[o]", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", path.join(outDir, `${id}.wav`)]);
  out.push({
    id,
    text,
    context,
    expect,
    file: `${id}.wav`,
    speechStartMs: LEAD_S * 1000,
    speechEndMs: Math.round(speechEnd * 1000),
    beats,
    totalMs: Math.round(total * 1000),
  });
}
writeFileSync(path.join(outDir, "fixtures.json"), JSON.stringify(out, null, 2));
for (const f of out) console.log(`${f.id}: speech ${f.speechStartMs}-${f.speechEndMs} ms, beats ${JSON.stringify(f.beats)}`);
