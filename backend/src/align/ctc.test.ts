import assert from "node:assert/strict";
import { test } from "node:test";
import { emissionsOf } from "../test/align.ts";
import { ALIGN, alignLine, forcedAlign, numberWords, placeLine, wordTokens } from "./ctc.ts";

const frames = (ms: number) => ms / ALIGN.frameMs;

test("spells printed words as the model's letters", () => {
  assert.deepEqual(wordTokens("Ay,"), wordTokens("AY"));
  assert.deepEqual(wordTokens("'seems.'"), wordTokens("seems"), "quotes around a word aren't said");
  assert.equal(wordTokens("don't").length, 5, "an apostrophe inside a word is a letter");
  assert.deepEqual(wordTokens("Café"), wordTokens("cafe"));
  assert.deepEqual(wordTokens("&"), wordTokens("and"));
  assert.deepEqual(wordTokens("Æneas"), wordTokens("aeneas"));
  assert.deepEqual(wordTokens("7"), wordTokens("seven"));
  assert.deepEqual(wordTokens("—"), []);
  assert.equal(numberWords(42), "forty two");
  assert.equal(numberWords(315), "three hundred fifteen");
  assert.equal(numberWords(2010), "two thousand ten");
  assert.equal(numberWords(1000), "one thousand");
  assert.equal(numberWords(12_000), null);
});

test("places each word where it is said", () => {
  const em = emissionsOf(
    [
      ["Hello", 460],
      ["there", 860],
      ["friend", 1960],
    ],
    frames(3000),
  );
  const line = alignLine(em, "Hello there, friend.")!;
  assert.deepEqual(line.wordStartsMs, [460, 860, 1960]);
  assert.equal(line.firstMs, 460);
  assert.equal(line.lastEndMs, 1960 + ALIGN.onsetLagMs + 11 * ALIGN.frameMs, "the end of the last word's last letter");
  assert.equal(line.fit, 1);
});

test("leaves out what isn't the line: a cue read aloud, an um, a restart, an okay", () => {
  const text = "To be, or not to be.";
  const said = (...words: [string, number][]) => alignLine(emissionsOf(words, frames(8000)), text)!;
  const line: [string, number][] = [
    ["to", 3460],
    ["be", 3660],
    ["or", 3860],
    ["not", 4060],
    ["to", 4260],
    ["be", 4460],
  ];
  const at = [3460, 3660, 3860, 4060, 4260, 4460];
  assert.deepEqual(said(["Let's", 460], ["withdraw", 760], ["my", 1160], ["lord", 1360], ...line).wordStartsMs, at, "the cue before it");
  assert.deepEqual(said(["um", 2460], ...line).wordStartsMs, at);
  assert.deepEqual(said(["to", 1460], ["be", 1660], ["or", 1860], ...line).wordStartsMs, at, "the false start");
  assert.deepEqual(said(...line, ["okay", 6060]).wordStartsMs, at, "the okay after it");
});

test("a [direction] and wordless pieces start with the next word said, or at the end", () => {
  const em = emissionsOf(
    [
      ["Go", 460],
      ["now", 1460],
    ],
    frames(3000),
  );
  const line = alignLine(em, "Go [Exit] — now [Aside]")!;
  // Pieces: Go, Exit, —, now, Aside.
  assert.deepEqual(line.wordStartsMs.slice(0, 4), [460, 1460, 1460, 1460]);
  assert.equal(line.wordStartsMs[4], line.lastEndMs);
});

test("isn't found when the take holds another line, or none", () => {
  const em = emissionsOf(
    [
      ["Would", 460],
      ["the", 760],
      ["night", 960],
      ["were", 1360],
      ["come", 1660],
    ],
    frames(4000),
  );
  const placed = placeLine(em, "A little more than kin, and less than kind.")!;
  assert.ok(placed.fit < ALIGN.minFit, `fit ${placed.fit}`);
  assert.equal(alignLine(em, "A little more than kin, and less than kind."), null);
  assert.equal(alignLine(emissionsOf([], frames(4000)), "A little more than kin."), null, "silence");
});

test("a paraphrase or a missed word is still found", () => {
  const em = emissionsOf(
    [
      ["If", 460],
      ["it", 660],
      ["is", 860],
      ["why", 1260],
      ["seems", 1560],
      ["it", 1960],
      ["so", 2160],
      ["peculiar", 2460],
      ["with", 3060],
      ["thee", 3360],
    ],
    frames(5000),
  );
  const line = alignLine(em, "If it be, Why seems it so particular with thee?")!;
  assert.ok(line, "found");
  assert.equal(line.wordStartsMs[0], 460);
  assert.equal(line.wordStartsMs[3], 1260);
  assert.equal(line.wordStartsMs[9], 3360);
});

test("nothing to place, too little audio or too big a search", () => {
  const em = emissionsOf([["Hello", 60]], frames(400));
  assert.equal(placeLine(em, "[Exit.]"), null, "only a direction");
  assert.equal(placeLine(em, ""), null);
  assert.equal(forcedAlign(emissionsOf([], 3), [wordTokens("Hello")]), null, "fewer frames than letters");
  const long = emissionsOf([], 10_000);
  assert.equal(forcedAlign(long, [new Array<number>(4000).fill(5)]), null, "past ALIGN.maxCells");
});
