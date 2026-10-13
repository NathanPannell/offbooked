import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { concatToM4a, makeSilence, makeTone, normalizeTake, probeDurationSeconds, probeSamples } from "./ffmpeg.ts";
import { contentHash, placeholderMs, planRender, type PlanLine } from "./plan.ts";

const line = (lineId: string, sectionId: string, takeId: string | null, text = "one two three"): PlanLine => ({ lineId, sectionId, text, takeId });

test("placeholder length is clamped words x 380 ms", () => {
  assert.equal(placeholderMs("one"), 1200);
  assert.equal(placeholderMs("a b c d e"), 1900);
  assert.equal(placeholderMs(Array(40).fill("word").join(" ")), 8000);
  assert.equal(placeholderMs("— ... —"), 1200);
});

test("timing uses 350 ms gaps within a section and 1200 ms at a section change", () => {
  const lines = [line("l1", "s1", "t1"), line("l2", "s1", null, "a b c d e"), line("l3", "s2", "t3")];
  const takes = new Map([
    ["t1", 48_000], // 1000 ms
    ["t3", 24_000], // 500 ms
  ]);
  const plan = planRender(lines, takes);
  assert.deepEqual(plan.timing, [
    { lineId: "l1", startMs: 0, endMs: 1000, recorded: true },
    { lineId: "l2", startMs: 1350, endMs: 3250, recorded: false },
    { lineId: "l3", startMs: 4450, endMs: 4950, recorded: true },
  ]);
  assert.equal(plan.totalSamples, 4950 * 48);
  assert.deepEqual(
    plan.segments.map((s) => [s.kind, s.samples]),
    [
      ["take", 48_000],
      ["silence", (350 + 1900 + 1200) * 48],
      ["take", 24_000],
    ],
  );
});

test("content hash changes with takes, order and section breaks only", () => {
  const base = [line("l1", "s1", "t1"), line("l2", "s1", null)];
  assert.equal(contentHash(base), contentHash([line("l1", "s1", "t1"), line("l2", "s1", null)]));
  assert.notEqual(contentHash(base), contentHash([line("l1", "s1", "t2"), line("l2", "s1", null)]));
  assert.notEqual(contentHash(base), contentHash([line("l2", "s1", null), line("l1", "s1", "t1")]));
  assert.notEqual(contentHash(base), contentHash([line("l1", "s1", "t1"), line("l2", "s2", null)]));
});

test("ffmpeg renders three clips with timing that matches the audio", { timeout: 120_000 }, async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "offbooked-render-test-"));
  try {
    const takes = new Map<string, number>();
    const files = new Map<string, string>();
    for (const [i, seconds] of [0.8, 1.3, 0.6].entries()) {
      const raw = path.join(dir, `raw${i}.wav`);
      await makeTone(seconds, 300 + i * 100, raw);
      const normalized = path.join(dir, `t${i}.flac`);
      const samples = await normalizeTake(raw, normalized);
      assert.ok(Math.abs(samples / 48_000 - seconds) < 0.1, `take ${i} keeps its length`);
      takes.set(`t${i}`, samples);
      files.set(`t${i}`, normalized);
    }
    const plan = planRender([line("a", "s1", "t0"), line("b", "s1", "t1"), line("c", "s2", "t2"), line("d", "s2", null)], takes);
    const inputs: string[] = [];
    for (const [i, seg] of plan.segments.entries()) {
      if (seg.kind === "take") inputs.push(files.get(seg.takeId)!);
      else {
        const f = path.join(dir, `silence${i}.flac`);
        await makeSilence(seg.samples, f);
        assert.equal(await probeSamples(f), seg.samples);
        inputs.push(f);
      }
    }
    const out = path.join(dir, "out.m4a");
    await concatToM4a(inputs, dir, out);
    const seconds = await probeDurationSeconds(out);
    const lastEnd = plan.timing[plan.timing.length - 1]!.endMs;
    assert.ok(seconds !== null && Math.abs(seconds * 1000 - lastEnd) < 60, `rendered ${seconds}s vs timing ${lastEnd}ms`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
