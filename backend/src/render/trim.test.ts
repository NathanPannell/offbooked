import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { promisify } from "node:util";
import { normalizeClip } from "./ffmpeg.ts";
import { RENDER_SETTINGS } from "./plan.ts";
import { detectSpeech, frameLevels, speechBounds, TRIM, voicing } from "./trim.ts";

const exec = promisify(execFile);

// Frame levels: `ms` of each level in turn, in 10 ms frames.
const levels = (...parts: [number, number][]) => parts.flatMap(([db, ms]) => Array<number>(ms / 10).fill(db));

test("keeps from just before the first sound to just after the last, padded", () => {
  const b = speechBounds(levels([-60, 800], [-20, 500], [-60, 100], [-22, 400], [-60, 1200]))!;
  assert.equal(b.startMs, 800 - TRIM.leadPadMs);
  assert.equal(b.endMs, 1800 + TRIM.tailPadMs);
});

test("the pause between words is never cut, however long", () => {
  const b = speechBounds(levels([-60, 300], [-20, 300], [-60, 1500], [-20, 300], [-60, 300]))!;
  assert.equal(b.startMs, 300 - TRIM.leadPadMs);
  assert.equal(b.endMs, 2400 + TRIM.tailPadMs);
});

test("a tap or click on its own is not speech", () => {
  const b = speechBounds(levels([-60, 300], [-5, 20], [-60, 500], [-20, 600], [-60, 400], [-8, 10], [-60, 300]))!;
  assert.equal(b.startMs, 820 - TRIM.leadPadMs);
  assert.equal(b.endMs, 1420 + TRIM.tailPadMs);
});

test("the threshold follows the clip's own floor: a noisy room is trimmed like a quiet one", () => {
  const quiet = speechBounds(levels([-70, 500], [-30, 1000], [-70, 500]))!;
  const noisy = speechBounds(levels([-38, 500], [-12, 1000], [-38, 500]))!;
  assert.equal(quiet.startMs, noisy.startMs);
  assert.equal(quiet.endMs, noisy.endMs);
});

test("never cuts into speech at the edges, and keeps clips it can't read whole", () => {
  // Speech from the first frame to the last: nothing to cut.
  const full = speechBounds(levels([-20, 1000]));
  assert.equal(full, null, "no range between floor and speech: keep whole");
  const edge = speechBounds(levels([-20, 600], [-60, 200], [-20, 400]))!;
  assert.equal(edge.startMs, 0);
  assert.equal(edge.endMs, 1200);
  assert.equal(speechBounds([]), null);
});

// Whether a frame is voiced, from frame ranges in ms: [from, to).
const voicedIn =
  (...spans: [number, number][]) =>
  (frame: number) =>
    spans.some(([from, to]) => frame * 10 >= from && frame * 10 < to);

describe("ends anchored on the voice", () => {
  // A hands-free take: a breath in, the line, the exhale, and the breath for the next line.
  const take = levels([-70, 300], [-35, 300], [-70, 150], [-20, 800], [-70, 200], [-38, 400], [-70, 600], [-34, 300], [-70, 200]);

  test("breaths before and after the line are cut", () => {
    const b = speechBounds(take, 10, voicedIn([750, 1550]))!;
    assert.equal(b.startMs, 750 - TRIM.leadPadMs);
    assert.equal(b.endMs, 1550 + TRIM.tailPadMs);
  });

  test("without voicing the breaths still count as sound", () => {
    const b = speechBounds(take, 10)!;
    assert.equal(b.startMs, 300 - TRIM.leadPadMs);
    assert.equal(b.endMs, 3050 + TRIM.tailPadMs);
  });

  test("an unvoiced start of the first word is kept, up to TRIM.onsetMs", () => {
    // "s" (unvoiced, 150 ms) straight into the vowel: all kept.
    const s = speechBounds(levels([-70, 500], [-30, 150], [-20, 600], [-70, 500]), 10, voicedIn([650, 1250]))!;
    assert.equal(s.startMs, 500 - TRIM.leadPadMs);
    // A breath running straight into the vowel: only TRIM.onsetMs of it.
    const breath = speechBounds(levels([-70, 300], [-32, 700], [-20, 600], [-70, 500]), 10, voicedIn([1000, 1600]))!;
    assert.equal(breath.startMs, 1000 - TRIM.onsetMs - TRIM.leadPadMs);
  });

  test('an "s" split from its vowel by a stop\'s closure stays with the word', () => {
    // "Speak": a 130 ms "s", the 70 ms silence of the "p", then the vowel.
    const speak = speechBounds(levels([-70, 500], [-30, 130], [-70, 70], [-20, 500], [-70, 800]), 10, voicedIn([700, 1200]))!;
    assert.equal(speak.startMs, 500 - TRIM.leadPadMs);
    // "...facts": the vowel, the "t"'s closure, then the final "s".
    const facts = speechBounds(levels([-70, 700], [-20, 500], [-70, 60], [-30, 120], [-70, 800]), 10, voicedIn([700, 1200]))!;
    assert.equal(facts.endMs, 1380 + TRIM.tailPadMs);
    // A breath, quieter than speech, across the same short gap is still cut.
    const breath = speechBounds(levels([-70, 500], [-42, 300], [-70, 70], [-20, 500], [-70, 800]), 10, voicedIn([870, 1370]))!;
    assert.equal(breath.startMs, 870 - TRIM.leadPadMs);
  });

  test("a final unvoiced sound is kept, up to TRIM.releaseMs", () => {
    const t = speechBounds(levels([-70, 500], [-20, 600], [-30, 120], [-70, 800]), 10, voicedIn([500, 1100]))!;
    assert.equal(t.endMs, 1220 + TRIM.tailPadMs);
    const long = speechBounds(levels([-70, 500], [-20, 600], [-32, 900], [-70, 500]), 10, voicedIn([500, 1100]))!;
    assert.equal(long.endMs, 1100 + TRIM.releaseMs + TRIM.tailPadMs);
  });

  test("a pause inside the line is kept whatever is in it", () => {
    const b = speechBounds(levels([-70, 400], [-20, 400], [-70, 300], [-35, 400], [-70, 300], [-20, 400], [-70, 600]), 10, voicedIn([400, 800], [1800, 2200]))!;
    assert.equal(b.startMs, 400 - TRIM.leadPadMs);
    assert.equal(b.endMs, 2200 + TRIM.tailPadMs);
  });

  test("a whisper (nothing voiced) falls back to the sound itself", () => {
    const b = speechBounds(levels([-70, 400], [-30, 800], [-70, 600]), 10, () => false)!;
    assert.equal(b.startMs, 400 - TRIM.leadPadMs);
    assert.equal(b.endMs, 1200 + TRIM.tailPadMs);
  });
});

describe("voicing", () => {
  const rate = 16_000;
  const pcm = (seconds: number, sample: (t: number) => number) =>
    Int16Array.from({ length: Math.round(seconds * rate) }, (_, i) => Math.round(32767 * Math.max(-1, Math.min(1, sample(i / rate)))));
  let seed = 7;
  const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;

  test("a voice repeats at its pitch; noise doesn't", () => {
    const voice = pcm(0.5, (t) => 0.3 * (Math.sin(2 * Math.PI * 140 * t) + 0.5 * Math.sin(2 * Math.PI * 280 * t) + 0.3 * Math.sin(2 * Math.PI * 420 * t)));
    const noise = pcm(0.5, () => 0.3 * random());
    const v = voicing(voice);
    const n = voicing(noise);
    const frames = Array.from({ length: 40 }, (_, i) => i + 5);
    assert.ok(
      frames.every((f) => v(f)),
      "voice frames are voiced",
    );
    assert.ok(frames.filter((f) => n(f)).length <= 2, "noise frames aren't");
    assert.equal(frameLevels(voice).length, 50);
  });

  test("low rumbling noise (a bump, a fan, a handled phone) isn't a voice either", () => {
    let level = 0;
    const rumble = pcm(0.5, () => (level = 0.97 * level + 0.03 * random()) * 4);
    const r = voicing(rumble);
    assert.ok(Array.from({ length: 40 }, (_, i) => i + 5).filter((f) => r(f)).length <= 2);
  });

  test("frames off the ends of the clip aren't voiced", () => {
    const v = voicing(pcm(0.2, (t) => 0.3 * Math.sin(2 * Math.PI * 150 * t)));
    assert.equal(v(0), false);
    assert.equal(v(1000), false);
  });
});

describe("on real audio", { skip: false }, () => {
  let dir = "";
  before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "offbooked-trim-"));
  });
  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  // 0.8 s of room noise (about -50 dBFS) with a tap at 0.3 s, three "syllables" of voiced sound
  // from 0.8 s to 1.8 s with short gaps, then 1.2 s of noise and a click at 2.5 s.
  async function makeTake(file: string, noise = 0.003) {
    const voice = "(between(t,0.8,1.0)+between(t,1.08,1.28)+between(t,1.36,1.8))*0.3*sin(2*PI*180*t)*(0.6+0.4*sin(2*PI*5*t))";
    const clicks = "(between(t,0.3,0.305)+between(t,2.5,2.508))*0.8";
    await exec("ffmpeg", [
      "-hide_banner",
      "-nostdin",
      "-y",
      "-f",
      "lavfi",
      "-i",
      `aevalsrc='${voice}+${clicks}+${noise}*(2*random(0)-1)':s=48000:d=3`,
      "-c:a",
      "pcm_s16le",
      file,
    ]);
  }

  test("finds the voice in a take with room noise and clicks", async () => {
    const take = path.join(dir, "take.wav");
    await makeTake(take);
    const b = (await detectSpeech(take))!;
    assert.ok(Math.abs(b.startMs - (800 - TRIM.leadPadMs)) <= 20, `start ${b.startMs}`);
    assert.ok(Math.abs(b.endMs - (1800 + TRIM.tailPadMs)) <= 20, `end ${b.endMs}`);
  });

  test("breaths, an exhale and the next line's breath are cut from a hands-free take", async () => {
    // Room noise; a breath in at 0.4–0.8 s, a voice at 1.0–2.2 s, an exhale at 2.4–2.9 s and the
    // breath for the next line at 3.6–4.0 s.
    const take = path.join(dir, "take-breaths.wav");
    const voice = "between(t,1.0,2.2)*0.25*(sin(2*PI*140*t)+0.5*sin(2*PI*280*t)+0.3*sin(2*PI*420*t))*(0.7+0.3*sin(2*PI*4*t))";
    const breaths = "(between(t,0.4,0.8)+0.7*between(t,2.4,2.9)+between(t,3.6,4.0))*0.05*(2*random(1)-1)";
    await exec("ffmpeg", [
      "-hide_banner",
      "-nostdin",
      "-y",
      "-f",
      "lavfi",
      "-i",
      `aevalsrc='${voice}+${breaths}+0.002*(2*random(0)-1)':s=48000:d=4.4`,
      "-c:a",
      "pcm_s16le",
      take,
    ]);
    const b = (await detectSpeech(take))!;
    assert.ok(Math.abs(b.startMs - (1000 - TRIM.leadPadMs)) <= 20, `start ${b.startMs}`);
    assert.ok(Math.abs(b.endMs - (2200 + TRIM.tailPadMs)) <= 20, `end ${b.endMs}`);
  });

  test("the normalized take is cut to the voice plus its pads", async () => {
    const take = path.join(dir, "take-noisy.wav");
    await makeTake(take, 0.02); // a noisy room, about -34 dBFS
    const samples = await normalizeClip(take, path.join(dir, "out.flac"), path.join(dir, "out.m4a"));
    const ms = (samples * 1000) / RENDER_SETTINGS.sampleRate;
    const expected = 1000 + TRIM.leadPadMs + TRIM.tailPadMs;
    assert.ok(Math.abs(ms - expected) <= 40, `kept ${ms.toFixed(0)} ms, expected about ${expected}`);
  });
});
