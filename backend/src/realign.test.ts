import assert from "node:assert/strict";
import { test } from "node:test";
import { layOnVoice, REALIGN, realignWordStarts, voiceStretches } from "./realign.ts";

const voice = (...pairs: [number, number][]) => pairs.map(([startMs, endMs]) => ({ startMs, endMs }));

test("a word heard late by the live tracker moves back to where its voice begins", () => {
  // "A little more than kin, [beat] and less than kind." The live starts put "and" a pause late.
  const text = "A little more than kin, and less than kind.";
  const live = [700, 820, 1010, 1180, 1350, 3600, 4240, 4400, 4600];
  const starts = realignWordStarts(live, text, voice([700, 1900], [3580, 3860], [4230, 4700]))!;
  assert.equal(starts[0], 700, "the first word starts with the voice");
  assert.equal(starts[5], 3580, '"and" starts where the voice comes back after the beat');
  assert.ok(starts[6]! >= 4230, "the next words follow on the voice after the next pause");
  assert.deepEqual(
    [...starts].sort((a, b) => a - b),
    starts,
    "in order",
  );
});

test("the first word starts with the voice, not the breath the live tracker put it on", () => {
  const starts = realignWordStarts([420, 900, 1150], "Get thee hence!", voice([700, 1500]))!;
  assert.equal(starts[0], 700);
  assert.ok(starts[1]! > 700 && starts[2]! > starts[1]!);
});

test("every stretch of voice after a pause starts a word", () => {
  const starts = layOnVoice([1000, 1100, 1200, 1300], [4, 4, 4, 4], voice([1000, 1400], [2000, 2400]))!;
  assert.equal(starts[0], 1000);
  assert.ok(starts.includes(2000), JSON.stringify(starts));
});

test("a stretch with no word (a cough) can be left out, at a cost", () => {
  const starts = layOnVoice([1000, 1100], [4, 4], voice([1000, 1300], [5000, 5100]))!;
  assert.deepEqual(starts, [1000, 1135]);
});

test("a [direction] takes no time: it starts with the next word, or at the end of the voice", () => {
  // Pieces: Go, [Exit], away, [beat] → "beat" is a narrator piece at the end.
  const text = "Go [Exit] away [beat]";
  const starts = realignWordStarts([500, 700, 900, 1200], text, voice([500, 1300]))!;
  assert.equal(starts.length, 4);
  assert.equal(starts[1], starts[2], "the direction starts with the next word");
  assert.equal(starts[3], 1300, "a direction at the end starts where the voice ends");
});

test("pauses shorter than a breath join the voice around them; slivers are dropped", () => {
  assert.deepEqual(voiceStretches(voice([0, 300], [400, 700], [1200, 1230], [1600, 2000])), voice([0, 700], [1600, 2000]));
  assert.ok(REALIGN.pauseMs > 100);
});

test("keeps the live starts when it can't help", () => {
  assert.equal(realignWordStarts(null, "Hello there", voice([0, 500])), null);
  assert.equal(realignWordStarts([0, 100, 200], "Hello there", voice([0, 500])), null, "the line has two words, not three");
  assert.equal(realignWordStarts([0, 100], "Hello there", []), null, "no voice");
  const many = Array.from({ length: REALIGN.maxWords + 1 }, (_, i) => i * 100);
  assert.equal(
    layOnVoice(
      many,
      many.map(() => 4),
      voice([0, 20_000]),
    ),
    null,
    "too long to search",
  );
});

test('a stretch well after the line (an "okay") is left without a word', () => {
  const starts = realignWordStarts([700, 1000, 1400], "Get thee hence!", voice([700, 1700], [3000, 3400]))!;
  assert.ok(starts[2]! < 1700, JSON.stringify(starts));
});

test("live starts that mostly miss the voice aren't re-timed", () => {
  // The tracker piled every word into a late pass, after the voice had ended.
  assert.equal(realignWordStarts([5000, 5050, 5100], "Get thee hence!", voice([700, 1700])), null);
});
