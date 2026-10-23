import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { integratedLoudness } from "./loudness.ts";

const exec = promisify(execFile);
const RATE = 48_000;
const tone = (seconds: number, amplitude: number, hz = 1000) =>
  Int16Array.from({ length: Math.round(seconds * RATE) }, (_, i) => Math.round(32767 * amplitude * Math.sin((2 * Math.PI * hz * i) / RATE)));

test("a full-scale 1 kHz sine reads -3.01 LUFS, as BS.1770 defines it", () => {
  const l = integratedLoudness(tone(3, 1))!;
  assert.ok(Math.abs(l - -3.01) < 0.1, `${l}`);
});

test("quieter by 20 dB reads 20 LU lower; a range picks the part asked for", () => {
  const quiet = integratedLoudness(tone(3, 0.1))!;
  assert.ok(Math.abs(quiet - -23.01) < 0.1, `${quiet}`);
  const both = new Int16Array([...tone(2, 0.1), ...tone(2, 1)]);
  assert.ok(Math.abs(integratedLoudness(both, 2 * RATE)! - -3.01) < 0.1);
});

test("silence, and gated-out near silence, have no loudness", () => {
  assert.equal(integratedLoudness(new Int16Array(RATE)), null);
  assert.equal(integratedLoudness(tone(1, 0.00001)), null);
  assert.equal(integratedLoudness(new Int16Array(0)), null);
});

test("agrees with ffmpeg's loudnorm on noise in speech-like bursts", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "offbooked-loudness-"));
  try {
    const raw = path.join(dir, "bursts.pcm");
    await exec("ffmpeg", [
      "-hide_banner",
      "-nostdin",
      "-f",
      "lavfi",
      "-i",
      "anoisesrc=color=pink:amplitude=0.2:d=4,volume='if(lt(mod(t,1),0.6),1,0.05)':eval=frame",
      "-ac",
      "1",
      "-ar",
      String(RATE),
      "-f",
      "s16le",
      raw,
    ]);
    const { stderr } = await exec("ffmpeg", [
      "-hide_banner",
      "-nostdin",
      "-f",
      "s16le",
      "-ar",
      String(RATE),
      "-ac",
      "1",
      "-i",
      raw,
      "-af",
      "loudnorm=print_format=json",
      "-f",
      "null",
      "-",
    ]);
    const ffmpegI = Number((JSON.parse(stderr.slice(stderr.lastIndexOf("{"), stderr.lastIndexOf("}") + 1)) as { input_i: string }).input_i);
    const b = await readFile(raw);
    const ours = integratedLoudness(new Int16Array(b.buffer, b.byteOffset, b.length / 2))!;
    assert.ok(Math.abs(ours - ffmpegI) < 0.6, `ours ${ours.toFixed(2)}, ffmpeg ${ffmpegI}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
