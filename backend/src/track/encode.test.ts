import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { encodeCue, makeTone } from "../render/ffmpeg.ts";
import { decodeToPcm, encodeTrack } from "./encode.ts";

const exec = promisify(execFile);
const RATE = 48_000;

// How loud each 100 ms window of a decoded track is (RMS of 16-bit samples).
async function levels(file: string, dir: string): Promise<number[]> {
  const pcm = path.join(dir, "out.pcm");
  await decodeToPcm(file, pcm);
  const data = await readFile(pcm);
  const window = RATE / 10;
  const out: number[] = [];
  for (let start = 0; start + window * 2 <= data.length; start += window * 2) {
    let sum = 0;
    for (let i = 0; i < window; i++) sum += data.readInt16LE(start + i * 2) ** 2;
    out.push(Math.sqrt(sum / window));
  }
  return out;
}

test("clips and silences are joined into one .m4a, each clip cut or padded to its planned length", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "offbooked-track-test-"));
  try {
    // Two 1 s tones as the .m4a clips line-by-line playback serves.
    const clips: [string, string][] = [];
    for (const name of ["a", "b"]) {
      const wav = path.join(dir, `${name}.wav`);
      await makeTone(1, name === "a" ? 440 : 660, wav);
      await encodeCue(wav, path.join(dir, `${name}.m4a`));
      await decodeToPcm(path.join(dir, `${name}.m4a`), path.join(dir, `${name}.pcm`));
      clips.push([`clips/${name}.m4a`, path.join(dir, `${name}.pcm`)]);
    }
    const out = path.join(dir, "track.m4a");
    // a cut to 0.5 s, 1 s of silence, b padded to 1.5 s (its last 0.5 s silent), 0.5 s of silence.
    await encodeTrack(
      [
        { kind: "clip", key: "clips/a.m4a", samples: RATE / 2 },
        { kind: "silence", samples: RATE },
        { kind: "clip", key: "clips/b.m4a", samples: (RATE * 3) / 2 },
        { kind: "silence", samples: RATE / 2 },
      ],
      new Map(clips),
      out,
      "64k",
    );
    const { stdout } = await exec("ffprobe", ["-v", "error", "-show_entries", "stream=codec_name,channels,sample_rate:format=duration", "-of", "json", out]);
    const probe = JSON.parse(stdout) as { streams: { codec_name: string; channels: number; sample_rate: string }[]; format: { duration: string } };
    assert.equal(probe.streams[0]!.codec_name, "aac");
    assert.equal(probe.streams[0]!.channels, 1);
    assert.equal(probe.streams[0]!.sample_rate, "48000");
    assert.ok(Math.abs(Number(probe.format.duration) - 3.5) < 0.06, probe.format.duration);

    // Sound where the clips were placed, silence where the gaps were.
    const rms = await levels(out, dir);
    const loud = (from: number, to: number) => rms.slice(from, to).every((v) => v > 500);
    const quiet = (from: number, to: number) => rms.slice(from, to).every((v) => v < 100);
    assert.ok(loud(0, 4), "a plays first");
    assert.ok(quiet(6, 14), "then a second of silence");
    assert.ok(loud(16, 24), "then b");
    assert.ok(quiet(26, 34), "b's padding and the last gap are silent");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("an encoder failure is reported, not left hanging", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "offbooked-track-test-"));
  try {
    await assert.rejects(encodeTrack([{ kind: "silence", samples: RATE }], new Map(), path.join(dir, "no-such-dir", "track.m4a"), "64k"), /ffmpeg failed/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
