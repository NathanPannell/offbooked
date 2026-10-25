// Runs the server's aligner (src/align) on the takes from make-takes.mjs and scores it against the
// truth: how far each served word start is from where the word was said, how much the cut keeps
// before the line's first word and after its last (negative: speech clipped), and whether the line
// was found. With --before <dir of an older backend/src> (one with realign.ts), also scores that
// pipeline with the phone's word starts on time (about 150 ms behind) and late (its model still
// loading: the first 2 s of words land together 2.2 s in), and the loudness cut alone.
// Usage: node bench/align/run.mjs <takes dir> --model <model.onnx> [--threads 1] [--before <src>]
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const opt = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const dir = args[0];
const modelPath = opt("--model");
if (!dir || !modelPath) throw new Error("Usage: node bench/align/run.mjs <takes dir> --model <model.onnx> [--threads 1] [--before <src>]");
const SRC = path.resolve(import.meta.dirname, "../../src");
const imp = (p) => import(pathToFileURL(p).href);
const [ctc, model, trim, timing] = await Promise.all(["align/ctc.ts", "align/model.ts", "render/trim.ts", "taketiming.ts"].map((m) => imp(path.join(SRC, m))));
const old = opt("--before") && (await Promise.all(["render/trim.ts", "realign.ts", "taketiming.ts"].map((m) => imp(path.join(opt("--before"), m)))));

const takes = JSON.parse(readFileSync(path.join(dir, "truth.json"), "utf8"));
const log = { info() {}, warn: console.warn, error: console.error };
const aligner = new model.ModelAligner({ modelPath, threads: Number(opt("--threads", 1)), log });
const decode = (f) =>
  trim.pcmOf(execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-i", f, "-vn", "-ac", "1", "-ar", "16000", "-f", "s16le", "-acodec", "pcm_s16le", "-"], { maxBuffer: 1 << 30 }));

// The truth's words (what the voice said) matched to the line's pieces (what the script prints).
const norm = (w) => w.toLowerCase().replace(/[^a-z0-9]/g, "");
function truthPerPiece(t) {
  const pieces = timing.linePieces(t.text).map((p) => (p.narrator ? null : norm(p.text)));
  const said = t.words.map((w) => norm(w.text));
  const L = Array.from({ length: pieces.length + 1 }, () => new Array(said.length + 1).fill(0));
  for (let i = pieces.length - 1; i >= 0; i--)
    for (let j = said.length - 1; j >= 0; j--) L[i][j] = pieces[i] && pieces[i] === said[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out = new Array(pieces.length).fill(null);
  for (let i = 0, j = 0; i < pieces.length && j < said.length; ) {
    if (pieces[i] && pieces[i] === said[j]) {
      out[i] = t.words[j].ms;
      i++;
      j++;
    } else if (L[i + 1][j] >= L[i][j + 1]) i++;
    else j++;
  }
  return out;
}
let seed = 7;
const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
function phone(t, truth, kind) {
  let last = 0;
  return timing.linePieces(t.text).map((_, i) => {
    let ms = truth[i] ?? truth.slice(i).find((x) => x != null) ?? t.endMs;
    if (kind === "ontime") ms += 150 + Math.round(rand() * 150 - 50);
    if (kind === "late") ms = ms < t.startMs + 2000 ? t.startMs + 2200 + 60 * i : ms + 400;
    return (last = Math.max(last, Math.round(ms)));
  });
}
function before(pcm, t, starts) {
  if (!starts) return { bounds: old[0].analyzePcm(pcm).bounds, words: null };
  let aligned = null;
  const bounds = old[0].analyzePcm(pcm, (voice) => {
    aligned = old[1].realignWordStarts(starts, t.text, voice);
    return aligned && old[2].wordAnchors(aligned, t.text);
  }).bounds;
  return { bounds, words: aligned ?? starts };
}

const rows = [];
for (const t of takes) {
  const pcm = decode(path.join(dir, t.file));
  const started = performance.now();
  const em = await aligner.emissions(pcm);
  const modelMs = performance.now() - started;
  const placed = ctc.placeLine(em, t.text);
  const line = ctc.alignLine(em, t.text);
  const truth = t.kind === "line" ? truthPerPiece(t) : null;
  const score = (r) => {
    const out = { lead: undefined, tail: undefined, errs: [] };
    if (!truth) return out;
    out.lead = t.startMs - Math.round(r.bounds?.startMs ?? 0);
    out.tail = Math.round(r.bounds?.endMs ?? pcm.length / 16) - t.endMs;
    if (r.words) out.errs = truth.flatMap((ms, i) => (ms == null ? [] : [r.words[i] - ms]));
    return out;
  };
  const row = { name: t.name, scenario: t.scenario, line: t.kind === "line", audioMs: pcm.length / 16, modelMs, found: !!line, fit: placed?.fit ?? 0 };
  row.after = score({ bounds: trim.analyzePcm(pcm, line).bounds, words: line?.wordStartsMs });
  if (old && truth) {
    row.late = score(before(pcm, t, phone(t, truth, "late")));
    row.ontime = score(before(pcm, t, phone(t, truth, "ontime")));
    row.loud = score(before(pcm, t, null));
  }
  rows.push(row);
  console.log(t.name.padEnd(28), `${(row.audioMs / 1000).toFixed(1)} s in ${Math.round(modelMs)} ms`, line ? "found" : "not found", `fit ${row.fit.toFixed(2)}`);
}
await aligner.close();
writeFileSync(path.join(dir, "results.json"), JSON.stringify(rows, null, 1));

const q = (xs, p) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(p * (xs.length - 1)))];
const mean = (xs) => Math.round(xs.reduce((a, b) => a + b, 0) / xs.length);
const cell = (rs, k) => {
  const lead = rs.map((r) => r[k].lead);
  const tail = rs.map((r) => r[k].tail);
  const errs = rs.flatMap((r) => r[k].errs.map(Math.abs));
  const words = errs.length ? `, words ${q(errs, 0.5)}/${q(errs, 0.9)}/${Math.max(...errs)} ms` : "";
  return `lead ${mean(lead)} (${Math.min(...lead)}…${Math.max(...lead)}), tail ${mean(tail)} (${Math.min(...tail)}…${Math.max(...tail)})${words}`;
};
const kinds = ["after", ...(old ? ["late", "ontime", "loud"] : [])];
const lines = rows.filter((r) => r.line);
console.log(`\nKept around the line, ms (mean (min…max); negative clips it), and word start error median/p90/max:`);
console.log(`| Scenario | n | ${kinds.join(" | ")} |\n|---|---|${kinds.map(() => "---").join("|")}|`);
for (const s of [...new Set(lines.map((r) => r.scenario))]) {
  const rs = lines.filter((r) => r.scenario === s);
  console.log(`| ${s} | ${rs.length} | ${kinds.map((k) => cell(rs, k)).join(" | ")} |`);
}
console.log(`| all | ${lines.length} | ${kinds.map((k) => cell(lines, k)).join(" | ")} |`);
const clipped = (k) => lines.filter((r) => r[k].lead < 0 || r[k].tail < 0).length;
console.log(`\nClipped: ${kinds.map((k) => `${k} ${clipped(k)}/${lines.length}`).join(", ")}`);
console.log(`Found: ${lines.filter((r) => r.found).length}/${lines.length} line takes, ${rows.filter((r) => !r.line && r.found).length}/${rows.filter((r) => !r.line).length} takes of another line or none`);
const speed = rows.map((r) => r.modelMs / r.audioMs);
console.log(`Model time per second of audio: median ${q(speed, 0.5).toFixed(3)} s, max ${Math.max(...speed).toFixed(3)} s`);
