import { execFile } from "node:child_process";
import { open, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { RENDER_SETTINGS } from "./plan.ts";

const exec = promisify(execFile);
const RATE = RENDER_SETTINGS.sampleRate;

async function ffmpeg(args: string[]): Promise<string> {
  const { stderr } = await exec("ffmpeg", ["-hide_banner", "-nostdin", "-y", ...args], { maxBuffer: 32 * 1024 * 1024, timeout: 10 * 60_000 });
  return stderr;
}

// Seconds of audio in a file. MediaRecorder WebM files often carry no duration header, so fall
// back to decoding the stream and reading the final timestamp.
export async function probeDurationSeconds(file: string): Promise<number | null> {
  try {
    const { stdout } = await exec("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", file]);
    const value = Number.parseFloat(stdout.trim());
    if (Number.isFinite(value) && value > 0) return value;
    const stderr = await ffmpeg(["-i", file, "-vn", "-f", "null", "-"]);
    const times = [...stderr.matchAll(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/g)];
    const last = times[times.length - 1];
    if (!last) return null;
    return Number(last[1]) * 3600 + Number(last[2]) * 60 + Number(last[3]);
  } catch {
    return null;
  }
}

// Exact length of a FLAC/WAV we produced, in samples at the render rate.
export async function probeSamples(file: string): Promise<number> {
  const { stdout } = await exec("ffprobe", ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=duration_ts,sample_rate,duration", "-of", "json", file]);
  const stream = (JSON.parse(stdout) as { streams?: { duration_ts?: number; sample_rate?: string; duration?: string }[] }).streams?.[0];
  if (stream?.duration_ts && Number(stream.sample_rate) === RATE) return stream.duration_ts;
  const seconds = Number.parseFloat(stream?.duration ?? "") || (await probeDurationSeconds(file)) || 0;
  return Math.round(seconds * RATE);
}

const trim = "silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.05";
const loudnorm = `loudnorm=I=${RENDER_SETTINGS.loudnessI}:TP=-1.5:LRA=11`;

// The length a FLAC file's STREAMINFO declares, in samples at the render rate, or null when the
// header doesn't say (then ffprobe measures it). Saves an ffprobe run for every clip we make.
export async function flacSamples(file: string): Promise<number | null> {
  const handle = await open(file, "r");
  try {
    const buf = Buffer.alloc(42);
    const { bytesRead } = await handle.read(buf, 0, 42, 0);
    if (bytesRead < 42 || buf.toString("latin1", 0, 4) !== "fLaC" || (buf[4]! & 0x7f) !== 0) return null;
    const info = buf.subarray(8); // STREAMINFO
    const rate = (info[10]! << 12) | (info[11]! << 4) | (info[12]! >> 4);
    const total = (info[13]! & 0x0f) * 2 ** 32 + info.readUInt32BE(14);
    return rate === RATE && total > 0 ? total : null;
  } finally {
    await handle.close();
  }
}

const measure = async (flac: string) => (await flacSamples(flac)) ?? (await probeSamples(flac));

// Decode, trim leading and trailing silence, loudness-normalize, 48 kHz mono FLAC. With `m4a`, the
// same ffmpeg run also writes the AAC file that browsers play line by line (about 50 ms extra).
// Returns the FLAC's length in samples.
export async function normalizeClip(input: string, output: string, m4a?: string): Promise<number> {
  const run = (filters: string) =>
    ffmpeg(
      m4a
        ? ["-i", input, "-vn", "-filter_complex", `${filters},aresample=${RATE},asplit[f][a]`,
           "-map", "[f]", "-ac", "1", "-sample_fmt", "s16", "-c:a", "flac", output,
           "-map", "[a]", "-ac", "1", "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart", m4a]
        : ["-i", input, "-vn", "-af", filters, "-ar", String(RATE), "-ac", "1", "-sample_fmt", "s16", "-c:a", "flac", output],
    );
  await run(`${trim},areverse,${trim},areverse,${loudnorm}`);
  let samples = await measure(output);
  if (samples < RATE / 20) {
    // Nearly everything was below the silence threshold; keep the take untrimmed instead.
    await run(loudnorm);
    samples = await measure(output);
  }
  return samples;
}

export function normalizeTake(input: string, output: string): Promise<number> {
  return normalizeClip(input, output);
}

export async function makeSilence(samples: number, output: string): Promise<void> {
  await ffmpeg(["-f", "lavfi", "-i", `anullsrc=r=${RATE}:cl=mono`, "-af", `atrim=end_sample=${samples}`, "-sample_fmt", "s16", "-c:a", "flac", output]);
}

// Joins same-format FLAC files in order and encodes AAC in an .m4a container.
export async function concatToM4a(files: string[], workDir: string, output: string): Promise<void> {
  const list = path.join(workDir, "concat.txt");
  await writeFile(list, files.map((f) => `file '${f.replace(/\\/g, "/").replace(/'/g, "'\\''")}'`).join("\n"));
  await ffmpeg(["-f", "concat", "-safe", "0", "-i", list, "-c:a", "aac", "-b:a", "128k", "-ar", String(RATE), "-ac", "1", "-movflags", "+faststart", output]);
}

// A synthesized cue line as a small AAC file that every browser's <audio> plays.
export async function encodeCue(input: string, output: string): Promise<void> {
  await ffmpeg(["-i", input, "-vn", "-c:a", "aac", "-b:a", "96k", "-ar", String(RATE), "-ac", "1", "-movflags", "+faststart", output]);
}

// Test and seed helper: a tone of the given length.
export async function makeTone(seconds: number, frequency: number, output: string): Promise<void> {
  await ffmpeg(["-f", "lavfi", "-i", `sine=frequency=${frequency}:sample_rate=${RATE}:duration=${seconds}`, "-af", "volume=0.3", "-ac", "1", output]);
}
