// Checks the aligner works where it is deployed (the Docker job in CI): finds a line in a recording
// and prints where its words start. Exits 1 when the model is missing or the line isn't found.
// Usage: node src/align/smoke.ts <audio file> "<the line>"
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadConfig } from "../config.ts";
import { consoleLog } from "../log.ts";
import { pcmOf } from "../render/trim.ts";
import { alignLine } from "./ctc.ts";
import { ModelAligner } from "./model.ts";

const [file, text] = process.argv.slice(2);
if (!file || !text) throw new Error('Usage: node src/align/smoke.ts <audio file> "<the line>"');
const config = loadConfig({ ...process.env, DATABASE_URL: "unused", SESSION_SECRET: "unused", INVITE_TOKEN_SECRET: "unused" });
const { stdout } = await promisify(execFile)(
  "ffmpeg",
  ["-hide_banner", "-nostdin", "-i", file, "-vn", "-ac", "1", "-ar", "16000", "-f", "s16le", "-acodec", "pcm_s16le", "-"],
  {
    encoding: "buffer",
    maxBuffer: 64 * 1024 * 1024,
  },
);
const pcm = pcmOf(stdout as Buffer);
const aligner = new ModelAligner({ modelPath: config.align.modelPath, threads: config.align.threads, log: consoleLog });
const started = performance.now();
const em = await aligner.emissions(pcm);
const line = em ? alignLine(em, text) : null;
const ms = Math.round(performance.now() - started);
await aligner.close();
console.log(
  JSON.stringify({ audioMs: Math.round(pcm.length / 16), alignMs: ms, maxRssMb: Math.round(process.resourceUsage().maxRSS / 1024), found: !!line, ...line }),
);
if (!line) process.exit(1);
