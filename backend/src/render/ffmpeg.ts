import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
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

// Decode, trim leading and trailing silence, loudness-normalize, 48 kHz mono FLAC.
export async function normalizeTake(input: string, output: string): Promise<number> {
  await ffmpeg(["-i", input, "-vn", "-af", `${trim},areverse,${trim},areverse,${loudnorm}`, "-ar", String(RATE), "-ac", "1", "-sample_fmt", "s16", "-c:a", "flac", output]);
  let samples = await probeSamples(output);
  if (samples < RATE / 20) {
    // Nearly everything was below the silence threshold; keep the take untrimmed instead.
    await ffmpeg(["-i", input, "-vn", "-af", loudnorm, "-ar", String(RATE), "-ac", "1", "-sample_fmt", "s16", "-c:a", "flac", output]);
    samples = await probeSamples(output);
  }
  return samples;
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

// Test and seed helper: a tone of the given length.
export async function makeTone(seconds: number, frequency: number, output: string): Promise<void> {
  await ffmpeg(["-f", "lavfi", "-i", `sine=frequency=${frequency}:sample_rate=${RATE}:duration=${seconds}`, "-af", "volume=0.3", "-ac", "1", output]);
}
