import { execFile } from "node:child_process";
import { open, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { RENDER_SETTINGS } from "./plan.ts";
import { integratedLoudness } from "./loudness.ts";
import { analyzePcm, pcmOf, shiftStretches, TRIM, type Stretch, type WordsOnVoice } from "./trim.ts";

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
  const { stdout } = await exec("ffprobe", [
    "-v",
    "error",
    "-select_streams",
    "a:0",
    "-show_entries",
    "stream=duration_ts,sample_rate,duration",
    "-of",
    "json",
    file,
  ]);
  const stream = (JSON.parse(stdout) as { streams?: { duration_ts?: number; sample_rate?: string; duration?: string }[] }).streams?.[0];
  if (stream?.duration_ts && Number(stream.sample_rate) === RATE) return stream.duration_ts;
  const seconds = Number.parseFloat(stream?.duration ?? "") || (await probeDurationSeconds(file)) || 0;
  return Math.round(seconds * RATE);
}

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

// The filters that cut a clip to its speech (see trim.ts), with a few ms of fade at each cut so it
// never clicks. Empty when there is nothing to cut. `stretches` is where the voice is in the input.
function trimFilters(analysis: ReturnType<typeof analyzePcm>): { filters: string; startMs: number; endMs: number; stretches: Stretch[] } {
  const { bounds: b, stretches } = analysis;
  if (!b || b.endMs - b.startMs < 50) return { filters: "", startMs: 0, endMs: Infinity, stretches };
  const s = (ms: number) => (ms / 1000).toFixed(3);
  const length = b.endMs - b.startMs;
  return {
    filters: `asetpts=PTS-STARTPTS,atrim=start=${s(b.startMs)}:end=${s(b.endMs)},asetpts=PTS-STARTPTS,afade=t=in:d=0.005,afade=t=out:st=${s(Math.max(0, length - 10))}:d=0.01,`,
    startMs: b.startMs,
    endMs: b.endMs,
    stretches,
  };
}

// Light clean-up for recordings made on phones: a high-pass for rumble and handling noise, then
// gentle FFT noise reduction (10 dB at most, tracking the clip's own noise floor). Stronger
// settings make voices watery, so this leaves the voice itself alone. TTS is clean already.
const CLEAN = "highpass=f=70,afftdn=nr=10:nf=-45:tn=1,";

// One fixed gain to the target loudness, so every clip, recorded or synthesized, plays at the same
// level, with a quick limiter that only touches the odd peak the gain pushes past -1.5 dBFS. The
// loudness is measured in-process (loudness.ts) on the clip as it will be cut. Single-pass
// loudnorm adjusts the gain as it goes and lands several LU off on clips a few seconds long, and
// its linear mode can't raise a clip that already peaks near full scale; it is only the fallback
// when there was nothing to measure (near silence). The gain is capped at ±30 dB so a nearly
// silent take isn't turned into loud hiss.
const PEAK_LIMIT = 10 ** (-1.5 / 20);
const levelTo = (inputI: number | null) => {
  if (inputI === null) return loudnorm;
  const gainDb = Math.max(-30, Math.min(30, RENDER_SETTINGS.loudnessI - inputI));
  return `volume=${gainDb.toFixed(2)}dB,alimiter=limit=${PEAK_LIMIT.toFixed(3)}:attack=2:release=40:level=false`;
};

// Decode, cut to the speech (leading and trailing silence and noise, with a small pad), clean it
// up when asked (recordings), bring it to the target loudness, 48 kHz mono FLAC. With `m4a`, the
// same ffmpeg run also writes the AAC file that browsers play line by line (about 50 ms extra).
// Returns the FLAC's length in samples.
export async function normalizeClip(input: string, output: string, m4a?: string, opts: { clean?: boolean } = {}): Promise<number> {
  return (await normalizeClipCut(input, output, m4a, opts)).samples;
}

// normalizeClip, also saying where the cut started in the input (ms), so timings measured on the
// input (TTS word timings, a take's word starts) can be moved onto the output, where the voice
// is in the output (`speech`, in ms of it: trim.ts's stretches, split on pauses), and whether it
// was cut to the voice at all (`cut`; false when the clip was kept whole).
export async function normalizeClipCut(
  input: string,
  output: string,
  m4a?: string,
  opts: { clean?: boolean; words?: WordsOnVoice | null } = {},
): Promise<{ samples: number; cutStartMs: number; speech: Stretch[]; cut: boolean }> {
  // One decode of the input: the clip at 48 kHz mono, cleaned up when asked, kept as raw samples
  // beside the output, and at 16 kHz for finding the speech, from the same run.
  const clip = `${output}.pcm`;
  const { stdout } = await exec(
    "ffmpeg",
    [
      "-hide_banner",
      "-nostdin",
      "-y",
      "-i",
      input,
      "-vn",
      "-filter_complex",
      `[0:a]aformat=channel_layouts=mono,aresample=${RATE},asplit[c][s];[c]${opts.clean ? CLEAN.replace(/,$/, "") : "anull"}[clip];[s]aresample=${TRIM.analysisRate}[speech]`,
      "-map",
      "[clip]",
      "-f",
      "s16le",
      "-acodec",
      "pcm_s16le",
      clip,
      "-map",
      "[speech]",
      "-f",
      "s16le",
      "-acodec",
      "pcm_s16le",
      "-",
    ],
    { encoding: "buffer", maxBuffer: 64 * 1024 * 1024, timeout: 10 * 60_000 },
  );
  try {
    const cut = trimFilters(analyzePcm(pcmOf(stdout as Buffer), opts.words));
    const samples48 = pcmOf(await readFile(clip));
    return await finish(clip, samples48, cut, output, m4a);
  } finally {
    await rm(clip, { force: true });
  }
}

// The second and last run: the decoded clip cut, levelled to the target and written as FLAC (and
// the .m4a when asked). Nearly all below the silence threshold: kept whole instead.
async function finish(
  clip: string,
  pcm: Int16Array,
  cut: ReturnType<typeof trimFilters>,
  output: string,
  m4a: string | undefined,
): Promise<{ samples: number; cutStartMs: number; speech: Stretch[]; cut: boolean }> {
  const at = (ms: number) => Math.max(0, Math.min(pcm.length, Math.round((ms * RATE) / 1000)));
  const run = (pre: string, from: number, to: number) => {
    const filters = `${pre}${levelTo(integratedLoudness(pcm, from, to))}`;
    const source = ["-f", "s16le", "-ar", String(RATE), "-ac", "1", "-i", clip];
    return ffmpeg(
      m4a
        ? [
            ...source,
            "-filter_complex",
            `${filters},aresample=${RATE},asplit[f][a]`,
            "-map",
            "[f]",
            "-ac",
            "1",
            "-sample_fmt",
            "s16",
            "-c:a",
            "flac",
            output,
            "-map",
            "[a]",
            "-ac",
            "1",
            "-c:a",
            "aac",
            "-b:a",
            "96k",
            "-movflags",
            "+faststart",
            m4a,
          ]
        : [...source, "-af", filters, "-ar", String(RATE), "-ac", "1", "-sample_fmt", "s16", "-c:a", "flac", output],
    );
  };
  await run(cut.filters, at(cut.startMs), at(cut.endMs));
  const samples = await measure(output);
  const lengthMs = (n: number) => (n * 1000) / RATE;
  if (samples < RATE / 20) {
    // Nearly everything was below the silence threshold; keep the take untrimmed instead.
    await run("", 0, pcm.length);
    const whole = await measure(output);
    return { samples: whole, cutStartMs: 0, speech: shiftStretches(cut.stretches, 0, lengthMs(whole)), cut: false };
  }
  return { samples, cutStartMs: cut.startMs, speech: shiftStretches(cut.stretches, cut.startMs, lengthMs(samples)), cut: cut.filters !== "" };
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

// Several normalized clips said together: overlaid from their starts (each is already cut to its
// first word), as long as the longest, then levelled like any clip. Returns the FLAC's samples.
export async function mixClips(inputs: string[], wav: string, output: string, m4a: string): Promise<number> {
  await ffmpeg([
    ...inputs.flatMap((f) => ["-i", f]),
    "-filter_complex",
    `amix=inputs=${inputs.length}:duration=longest:dropout_transition=0:normalize=0`,
    "-ar",
    String(RATE),
    "-ac",
    "1",
    "-c:a",
    "pcm_s16le",
    wav,
  ]);
  return normalizeClip(wav, output, m4a);
}

// A synthesized cue line as a small AAC file that every browser's <audio> plays.
export async function encodeCue(input: string, output: string): Promise<void> {
  await ffmpeg(["-i", input, "-vn", "-c:a", "aac", "-b:a", "96k", "-ar", String(RATE), "-ac", "1", "-movflags", "+faststart", output]);
}

// Test and seed helper: a tone of the given length.
export async function makeTone(seconds: number, frequency: number, output: string): Promise<void> {
  await ffmpeg(["-f", "lavfi", "-i", `sine=frequency=${frequency}:sample_rate=${RATE}:duration=${seconds}`, "-af", "volume=0.3", "-ac", "1", output]);
}
