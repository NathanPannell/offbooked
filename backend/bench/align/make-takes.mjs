// Builds hands-free-shaped takes from the spoken utterances (say.ps1): room noise, a breath before
// and after, and per line: plain, a beat, a cue read aloud before it, an "um" before it, a restart, an
// "Okay." after it; plus takes of the wrong line and one of no speech. Writes <out>/<name>.webm (Opus,
// as Chrome records) and <out>/truth.json with every word's start (ms of the take) and where the
// line's speech starts and ends. With --noisy, <out>-noisy gets the same takes (but the long speech)
// with heavy room noise, echo and 24 kb/s Opus.
// Usage: node bench/align/make-takes.mjs <spoken dir> <out dir> [--noisy]
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { LINES, LONG } from "./lines.mjs";

const [, , SP, OUT, flag] = process.argv;
if (!SP || !OUT) throw new Error("Usage: node bench/align/make-takes.mjs <spoken dir> <out dir> [--noisy]");
mkdirSync(OUT, { recursive: true });
// SAPI reports word positions on a 16 kHz clock while it writes 22.05 kHz files.
const SAPI = 16000 / 22050;
const ff = (args) => {
  const r = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", ...args], { encoding: "utf8" });
  if (r.status) throw new Error(r.stderr);
};
const dur = (f) => Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", f]).toString().trim()) * 1000;

// Each utterance cut to its sound, with its word times moved to match.
const utt = {};
const load = (id) => {
  if (utt[id]) return utt[id];
  const raw = path.join(SP, `${id}.wav`);
  const sil = spawnSync("ffmpeg", ["-hide_banner", "-nostdin", "-i", raw, "-af", "silencedetect=noise=-50dB:d=0.05", "-f", "null", "-"], { encoding: "utf8" }).stderr;
  const lead = /silence_start: 0\b/.test(sil) ? Number(sil.match(/silence_end: ([\d.]+)/)[1]) * 1000 : 0;
  // PowerShell writes the JSON with a byte order mark, which trimStart drops.
  const words = JSON.parse(readFileSync(path.join(SP, `${id}.words.json`), "utf8").trimStart());
  const file = path.join(OUT, `_${id}.wav`);
  ff(["-i", raw, "-af", `atrim=start=${lead / 1000},asetpts=PTS-STARTPTS,areverse,silenceremove=start_periods=1:start_threshold=-50dB,areverse,aresample=16000,volume=-4dB`, "-ac", "1", file]);
  return (utt[id] = { file, ms: dur(file), words: [].concat(words).map((w) => ({ text: w.text, ms: Math.max(0, w.ms * SAPI - lead) })) });
};
const breath = (at, len, amp) =>
  `anoisesrc=color=pink:amplitude=${amp}:r=16000:d=${len},highpass=f=300,afade=t=in:d=${len * 0.45},afade=t=out:st=${len * 0.5}:d=${len * 0.5},adelay=${Math.round(at * 1000)}:all=1`;

// Lays the parts ({ id, at: ms }) on room noise, with breaths, and writes the take.
function build(name, parts, totalMs, extra) {
  const inputs = [];
  const chains = [`anoisesrc=color=pink:amplitude=0.004:r=16000:d=${totalMs / 1000}[n]`];
  const labels = ["[n]"];
  parts.forEach((p, i) => {
    inputs.push("-i", load(p.id).file);
    chains.push(`[${i}:a]adelay=${Math.round(p.at)}:all=1[p${i}]`);
    labels.push(`[p${i}]`);
  });
  const first = parts.length ? Math.min(...parts.map((p) => p.at)) : 1500;
  const lastEnd = parts.length ? Math.max(...parts.map((p) => p.at + load(p.id).ms)) : 2000;
  chains.push(`${breath(Math.max(0, first - 520) / 1000, 0.4, 0.02)}[b0]`, `${breath((lastEnd + 250) / 1000, 0.5, 0.012)}[b1]`, `${breath(Math.max(lastEnd + 400, totalMs - 900) / 1000, 0.45, 0.02)}[b2]`);
  labels.push("[b0]", "[b1]", "[b2]");
  chains.push(`${labels.join("")}amix=inputs=${labels.length}:duration=first:normalize=0[o]`);
  const wav = path.join(OUT, `${name}.wav`);
  ff([...inputs, "-filter_complex", chains.join(";"), "-map", "[o]", "-ac", "1", "-ar", "16000", wav]);
  ff(["-i", wav, "-ar", "48000", "-c:a", "libopus", "-b:a", "48k", path.join(OUT, `${name}.webm`)]);
  return { name, file: `${name}.webm`, totalMs, ...extra };
}

const takes = [];
const truthOf = (id, at) => {
  const u = load(id);
  return { words: u.words.map((w) => ({ text: w.text, ms: Math.round(at + w.ms) })), startMs: Math.round(at + u.words[0].ms), endMs: Math.round(at + u.ms) };
};
for (const l of [...LINES, LONG]) {
  const take = (scenario, parts, lineId, lineAt) => {
    const end = Math.max(...parts.map((p) => p.at + load(p.id).ms));
    takes.push({ ...build(`${l.id}--${scenario}`, parts, end + 3500, { line: l.id, scenario, text: l.text, kind: "line" }), ...truthOf(lineId, lineAt) });
  };
  take("plain", [{ id: l.id, at: 700 }], l.id, 700);
  take("beat", [{ id: `${l.id}-beat`, at: 700 }], `${l.id}-beat`, 700);
  if (l === LONG) continue;
  const after = (id, gap, start = 600) => start + load(id).ms + gap;
  take("cue-before", [{ id: `${l.id}-cue`, at: 600 }, { id: l.id, at: after(`${l.id}-cue`, 650) }], l.id, after(`${l.id}-cue`, 650));
  take("okay-after", [{ id: l.id, at: 700 }, { id: `okay-${l.voice}`, at: after(l.id, 750, 700) }], l.id, 700);
  take("restart", [{ id: `${l.id}-frag`, at: 700 }, { id: l.id, at: after(`${l.id}-frag`, 600, 700) }], l.id, after(`${l.id}-frag`, 600, 700));
  take("um-before", [{ id: `um-${l.voice}`, at: 600 }, { id: l.id, at: after(`um-${l.voice}`, 900) }], l.id, after(`um-${l.voice}`, 900));
}
// Another line's take for each line's text, and one of no speech: nothing to find.
LINES.forEach((l, i) => {
  for (const k of [1, 3, 4]) {
    const other = LINES[(i + k) % LINES.length];
    takes.push(build(`${l.id}--as-${other.id}`, [{ id: other.id, at: 700 }], 700 + load(other.id).ms + 3500, { line: l.id, scenario: "wrong-line", text: l.text, kind: "none" }));
  }
});
takes.push(build("silent--breath-only", [], 5000, { line: LINES[0].id, scenario: "no-speech", text: LINES[0].text, kind: "none" }));
writeFileSync(path.join(OUT, "truth.json"), JSON.stringify(takes, null, 1));
console.log(`${takes.length} takes in ${OUT}`);

if (flag === "--noisy") {
  const noisy = `${OUT}-noisy`;
  mkdirSync(noisy, { recursive: true });
  const some = takes.filter((t) => t.line !== LONG.id);
  for (const t of some)
    ff([
      "-i",
      path.join(OUT, `${t.name}.wav`),
      "-filter_complex",
      `[0:a]aecho=0.8:0.6:35|70|110:0.35|0.25|0.15,volume=-6dB[s];anoisesrc=color=pink:amplitude=0.03:r=16000:d=${t.totalMs / 1000}[n];[s][n]amix=inputs=2:duration=first:normalize=0,highpass=f=120,lowpass=f=6000[o]`,
      "-map",
      "[o]",
      "-ar",
      "48000",
      "-c:a",
      "libopus",
      "-b:a",
      "24k",
      path.join(noisy, `${t.name}.webm`),
    ]);
  writeFileSync(path.join(noisy, "truth.json"), JSON.stringify(some, null, 1));
  console.log(`${some.length} noisy takes in ${noisy}`);
}
