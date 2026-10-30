import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { planCues, planStretches, type PlanLine } from "./cuePlan.ts";
import { SKIP_PAUSE_MS, SKIP_PEAK, SKIP_SOUND_MS, skipSamples } from "./skipSound.ts";

// What the player and the server share. The rule's own cases are in web/src/player/cuePlan.test.ts;
// these are the ones that keep the two sides one rule.

const here = path.dirname(fileURLToPath(import.meta.url));

for (const file of ["cuePlan.ts", "skipSound.ts"]) {
  test(`${file} is the same file in the player and on the server`, async () => {
    const [server, player] = await Promise.all([readFile(path.join(here, file), "utf8"), readFile(path.join(here, "../../../web/src/player", file), "utf8")]);
    assert.equal(server, player, `copy one over the other: web/src/player/${file} and backend/src/track/${file} must not differ`);
  });
}

test("a one-act part with lines at either end is one file, however long the play", () => {
  const lines: PlanLine[] = Array.from({ length: 2000 }, (_, i) => ({ lineId: `l${i}`, sectionId: "s", text: "Some words are said here." }));
  const plan = planCues(lines, new Set(["l2", "l4", "l1995", "l1997"]))!;
  const stretches = planStretches(lines, plan);
  assert.equal(stretches.length, 1);
  assert.deepEqual(stretches[0]!.lineIds, ["l0", "l1", "l2", "l3", "l4", "l1994", "l1995", "l1996", "l1997", "l1998", "l1999"]);
  assert.deepEqual(stretches[0]!.skips, ["l4"]);
});

test("the fast-forward sound is about 0.4 s, far under the old -9 dBFS, and the same every time", () => {
  const rate = 48_000;
  const samples = skipSamples(rate);
  assert.equal(samples.length, Math.round((rate * SKIP_PAUSE_MS) / 1000));
  const sound = samples.subarray(0, Math.round((rate * SKIP_SOUND_MS) / 1000));
  const peak = sound.reduce((most, s) => Math.max(most, Math.abs(s)), 0);
  assert.ok(Math.abs(peak - SKIP_PEAK) < 1e-6, String(peak));
  assert.ok(20 * Math.log10(peak) < -18, "well under the old -9 dBFS");
  assert.ok(
    samples.subarray(sound.length).every((s) => s === 0),
    "a breath of silence after it",
  );
  assert.deepEqual(skipSamples(rate), samples);
  assert.equal(SKIP_SOUND_MS, 400);
});
