import assert from "node:assert/strict";
import { test } from "node:test";
import { FAST_FORWARD_MS, fastForwardPcm, fastForwardSamples } from "./fastForward.ts";

test("the fast-forward sound is short, the same every time, and quieter than speech", () => {
  const a = fastForwardSamples(48_000);
  assert.equal(a.length, (48_000 * FAST_FORWARD_MS) / 1000);
  assert.deepEqual(a, fastForwardSamples(48_000));
  const peak = a.reduce((m, s) => Math.max(m, Math.abs(s)), 0);
  assert.ok(peak > 0.3 && peak <= 0.35 + 1e-6, `peak ${peak}`);
  // Fades in and out: silent at both ends.
  assert.ok(Math.abs(a[0]!) < 0.01 && Math.abs(a[a.length - 1]!) < 0.01);
});

test("as raw 16-bit samples for the track encoder", () => {
  const pcm = fastForwardPcm(48_000);
  assert.equal(pcm.length, ((48_000 * FAST_FORWARD_MS) / 1000) * 2);
  assert.ok(pcm.some((b) => b !== 0));
});
