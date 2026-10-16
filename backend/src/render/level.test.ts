import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";
import { normalizeClip } from "./ffmpeg.ts";
import { RENDER_SETTINGS } from "./plan.ts";

const exec = promisify(execFile);
let dir = "";

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "offbooked-level-"));
});
after(async () => {
  await rm(dir, { recursive: true, force: true });
});

// Speech-like audio: a tone switching on and off every 300 ms for `seconds`, at `db`, with
// optional pink noise under it (and before and after it, as on a phone).
async function voice(name: string, db: number, seconds: number, noise?: number): Promise<string> {
  const file = path.join(dir, `${name}.wav`);
  const tone = `sine=f=220:r=48000:d=${seconds},volume=${db}dB,volume='if(lt(mod(t,0.6),0.3),1,0.15)':eval=frame,adelay=600,apad=pad_dur=0.6`;
  const args = noise === undefined
    ? ["-f", "lavfi", "-i", tone]
    : ["-f", "lavfi", "-i", tone, "-f", "lavfi", "-i", `anoisesrc=c=pink:a=${10 ** (noise / 20)}:r=48000:d=${seconds + 1.2}`,
       "-filter_complex", "[0][1]amix=inputs=2:duration=first:normalize=0"];
  await exec("ffmpeg", ["-hide_banner", "-nostdin", "-y", ...args, "-ac", "1", file]);
  return file;
}

async function loudness(file: string): Promise<number> {
  const { stderr } = await exec("ffmpeg", ["-hide_banner", "-nostats", "-i", file, "-af", "ebur128", "-f", "null", "-"]);
  const m = /Integrated loudness:\s+I:\s+(-?[\d.]+) LUFS/.exec(stderr);
  return Number(m?.[1]);
}

test("quiet, loud and short clips all come out at the same loudness", async () => {
  const clips = [
    ["quiet", await voice("quiet", -14, 4, -60)],
    ["loud", await voice("loud", 14, 4)],
    ["short", await voice("short", -6, 0.9)],
  ] as const;
  for (const [name, file] of clips) {
    const out = path.join(dir, `${name}.flac`);
    await normalizeClip(file, out);
    const lufs = await loudness(out);
    assert.ok(Math.abs(lufs - RENDER_SETTINGS.loudnessI) <= 1.5, `${name}: ${lufs} LUFS`);
  }
});

// RMS level (dBFS) of the first `ms` of a file: the pad kept before the first word.
async function leadRms(file: string, ms: number): Promise<number> {
  const { stderr } = await exec("ffmpeg", ["-hide_banner", "-i", file, "-af", `atrim=0:${ms / 1000},astats=metadata=0`, "-f", "null", "-"]);
  return Number(/RMS level dB:\s+(-?[\d.]+|-inf)/.exec(stderr)?.[1]);
}

// The denoiser treats a steady test tone as noise, so this checks the room noise before the first
// sound rather than the tone's level. (On Piper speech with pink noise and hum added, the cleaned
// take measured within 0.2 LU of the target and its noise fell from -34 to -45 dB.)
test("clean-up lowers background noise on a recording", async () => {
  const noisy = await voice("noisy", -14, 3, -48);
  const plain = path.join(dir, "noisy-plain.flac");
  const clean = path.join(dir, "noisy-clean.flac");
  await normalizeClip(noisy, plain);
  await normalizeClip(noisy, clean, undefined, { clean: true });
  const [before, afterClean] = [await leadRms(plain, 100), await leadRms(clean, 100)];
  assert.ok(afterClean <= before - 6, `noise ${before} dB → ${afterClean} dB`);
});
