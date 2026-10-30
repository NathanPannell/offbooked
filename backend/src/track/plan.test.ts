import assert from "node:assert/strict";
import { test } from "node:test";
import type { ResolvedLineAudio } from "../linestream.ts";
import { myLinePauseMs, planTrack, spokenText, type TrackLine } from "./plan.ts";

const clip = (lineId: string, durationMs: number, extra: Partial<ResolvedLineAudio> = {}): ResolvedLineAudio => ({
  lineId,
  audioKey: `clips/${lineId}.m4a`,
  durationMs,
  source: "tts",
  ready: true,
  ...extra,
});

const line = (lineId: string, sectionId: string, audio: ResolvedLineAudio, text = "Five words are spoken here."): TrackLine => ({
  lineId,
  sectionId,
  text,
  audio,
});

test("lines play end to end with the player's pauses: short in a scene, longer at a scene change", () => {
  const plan = planTrack([line("a", "s1", clip("a", 1000)), line("b", "s1", clip("b", 2000)), line("c", "s2", clip("c", 500))], new Set(), "read");
  assert.deepEqual(
    plan.items.map((i) => [i.lineId, i.kind, i.startMs, i.durationMs]),
    [
      ["a", "line", 0, 1000],
      ["b", "line", 1350, 2000],
      ["c", "line", 4550, 500],
    ],
  );
  assert.equal(plan.totalSamples, 5050 * 48);
  assert.deepEqual(plan.pieces, [
    { kind: "clip", key: "clips/a.m4a", samples: 48_000 },
    { kind: "silence", samples: 350 * 48 },
    { kind: "clip", key: "clips/b.m4a", samples: 96_000 },
    { kind: "silence", samples: 1200 * 48 },
    { kind: "clip", key: "clips/c.m4a", samples: 24_000 },
  ]);
});

test("my lines: read plays them, skip leaves a silence to say them, pause leaves the silence and then plays them", () => {
  const lines = [line("a", "s1", clip("a", 1000)), line("b", "s1", clip("b", 2000, { source: "actor" })), line("c", "s1", clip("c", 1000))];
  const mine = new Set(["b"]);
  const read = planTrack(lines, mine, "read");
  assert.deepEqual(
    read.items.map((i) => i.kind),
    ["line", "line", "line"],
  );

  // A recorded line is timed from its take: 2000 ms plus 15% (or 500 ms, if more).
  const skip = planTrack(lines, mine, "skip");
  assert.deepEqual(
    skip.items.map((i) => [i.lineId, i.kind, i.startMs, i.durationMs]),
    [
      ["a", "line", 0, 1000],
      ["b", "speak", 1350, 2500],
      ["c", "line", 4200, 1000],
    ],
  );
  assert.ok(!skip.pieces.some((p) => p.kind === "clip" && p.key === "clips/b.m4a"), "a skipped line's voice is left out");

  const pause = planTrack(lines, mine, "pause");
  assert.deepEqual(
    pause.items.map((i) => [i.lineId, i.kind, i.startMs, i.durationMs]),
    [
      ["a", "line", 0, 1000],
      ["b", "speak", 1350, 2500],
      ["b", "line", 3850, 2000],
      ["c", "line", 6200, 1000],
    ],
  );
});

test("a jump leaves its lines out by not listing them: the fast-forward sound takes the place of the pause before the line it lands on", () => {
  const plan = planTrack(
    [line("a", "s1", clip("a", 1000)), line("x", "s1", clip("x", 500)), line("b", "s2", clip("b", 1000)), line("c", "s2", clip("c", 1000))],
    new Set(["a"]),
    "read",
    new Set(["x"]),
  );
  assert.deepEqual(
    plan.items.map((i) => [i.lineId, i.startMs]),
    [
      ["a", 0],
      ["x", 1350],
      ["b", 1850 + 650], // not the 1200 ms of a scene change
      ["c", 3500 + 350],
    ],
  );
  assert.deepEqual(
    plan.pieces.map((p) => p.kind),
    ["clip", "silence", "clip", "skip", "clip", "silence", "clip"],
  );
});

test("a line with nothing to play keeps its silence without a clip's timings; a direction nobody voices takes no time", () => {
  const silent: ResolvedLineAudio = {
    lineId: "b",
    audioKey: null,
    durationMs: 1900,
    source: "none",
    ready: true,
    segments: [{ startMs: 0, endMs: 10, text: "x" }] as never,
  };
  const direction: ResolvedLineAudio = { lineId: "c", audioKey: null, durationMs: 0, source: "none", ready: true };
  const plan = planTrack(
    [line("a", "s1", clip("a", 1000)), line("b", "s1", silent), line("c", "s1", direction), line("d", "s1", clip("d", 1000))],
    new Set(),
    "read",
  );
  assert.deepEqual(
    plan.items.map((i) => [i.lineId, i.startMs, i.durationMs, i.source]),
    [
      ["a", 0, 1000, "tts"],
      ["b", 1350, 1900, "none"],
      ["c", 3600, 0, "none"],
      ["d", 3950, 1000, "tts"],
    ],
  );
  assert.equal(plan.items[1]!.segments, undefined);
  // Silences next to each other become one piece.
  assert.deepEqual(plan.pieces[1], { kind: "silence", samples: (350 + 1900 + 350 + 350) * 48 });
});

test("a clip's word timings travel with its item", () => {
  const plan = planTrack(
    [line("a", "s1", clip("a", 1000, { source: "actor", speech: [{ startMs: 100, endMs: 900 }], wordStartsMs: [120, 400, 700] }))],
    new Set(),
    "read",
  );
  assert.deepEqual(plan.items[0], {
    lineId: "a",
    kind: "line",
    startMs: 0,
    durationMs: 1000,
    source: "actor",
    speech: [{ startMs: 100, endMs: 900 }],
    wordStartsMs: [120, 400, 700],
  });
});

test("the listener's pause matches the player's: a take's length plus a little, else its spoken words at 150 a minute", () => {
  assert.equal(myLinePauseMs("anything", 2000), 2500);
  assert.equal(myLinePauseMs("anything", 10_000), 11_500);
  assert.equal(myLinePauseMs("anything", 200), 1000);
  assert.equal(myLinePauseMs("One two three four five six seven eight nine ten.", null), 4000);
  assert.equal(myLinePauseMs("Go [Exit] now.", null), 1000);
  assert.equal(spokenText("To be [aside] or not {beat} to be").replace(/\s+/g, " "), "To be or not to be");
});
