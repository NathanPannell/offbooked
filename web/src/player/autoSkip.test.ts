import { describe, expect, it } from "vitest";
import { aheadText, classifyGap, estimateMs, measureGap, planJumps, sameJumps, SKIP_OVER_LINES, SKIP_OVER_MS, STOP_OVER_MS } from "./autoSkip";
import { myStops } from "./myLines";
import { LINE_GAP_MS, SECTION_GAP_MS, type QueueLine } from "./queue";

const q = (lineId: string, sectionId: string, text = "Four words said here."): QueueLine => ({ lineId, sectionId, text, kind: "dialogue" });

describe("classifying the stretch between two of my lines", () => {
  it("plays a short one through: up to three lines and a minute", () => {
    expect(classifyGap({ lines: 0, ms: 0, scenes: 0 })).toBe("play");
    expect(classifyGap({ lines: SKIP_OVER_LINES, ms: SKIP_OVER_MS, scenes: 0 })).toBe("play");
  });

  it("skips one with more than three lines, or over a minute", () => {
    expect(classifyGap({ lines: SKIP_OVER_LINES + 1, ms: 5_000, scenes: 0 })).toBe("skip");
    expect(classifyGap({ lines: 2, ms: SKIP_OVER_MS + 1, scenes: 0 })).toBe("skip");
    expect(classifyGap({ lines: 400, ms: STOP_OVER_MS, scenes: 0 })).toBe("skip");
  });

  it("stops before one over twenty minutes, or with a whole scene in it", () => {
    expect(classifyGap({ lines: 400, ms: STOP_OVER_MS + 1, scenes: 0 })).toBe("stop");
    expect(classifyGap({ lines: 5, ms: 20_000, scenes: 1 })).toBe("stop");
  });

  it("plays through a short stretch even when a tiny scene is in it", () => {
    expect(classifyGap({ lines: 2, ms: 8_000, scenes: 1 })).toBe("play");
  });
});

describe("measuring a stretch", () => {
  // Scene 1: M, a, b. Scene 2: c. Scene 3: d, N.
  const queue = [q("M", "s1"), q("a", "s1"), q("b", "s1"), q("c", "s2"), q("d", "s3"), q("N", "s3")];

  it("counts the lines between, their audio at the playback speed, and the pauses at 1×", () => {
    const known: Record<string, number> = { a: 10_000, b: 2_000, c: 4_000, d: 6_000 };
    const pauses = 2 * LINE_GAP_MS + 2 * SECTION_GAP_MS + LINE_GAP_MS;
    expect(measureGap(queue, 0, 5, (id) => known[id], 1)).toEqual({ lines: 4, ms: 22_000 + pauses, scenes: 1 });
    expect(measureGap(queue, 0, 5, (id) => known[id], 2).ms).toBe(11_000 + pauses);
  });

  it("estimates a line with no known length from its words", () => {
    expect(estimateMs("Four words said here.")).toBe(1600);
    expect(estimateMs("Oh!")).toBe(1000);
    expect(measureGap(queue, 0, 2, () => undefined, 1).ms).toBe(1600 + 2 * LINE_GAP_MS);
  });

  it("counts only scenes neither line is in", () => {
    expect(measureGap(queue, 0, 2, () => 1000, 1).scenes).toBe(0);
    expect(measureGap(queue, 2, 5, () => 1000, 1).scenes).toBe(1);
  });
});

describe("the plan for a part", () => {
  // The e2e script (fixtures/gaps.docx), HAMLET's lines in capitals: scene 1 is H1, h, b, h, b, H2;
  // scene 2 is b, h, b, h; scene 3 is h, H3.
  const ids = ["H1", "s1a", "s1b", "s1c", "s1d", "H2", "s2a", "s2b", "s2c", "s2d", "s3a", "H3"];
  const queue = ids.map((id) => q(id, id === "H1" || id === "H2" || id.startsWith("s1") ? "s1" : id === "H3" || id.startsWith("s3") ? "s3" : "s2"));
  const mine = new Set(["H1", "H2", "H3"]);
  const plan = planJumps(queue, myStops(queue, mine), () => undefined, 1);

  it("skips four lines in scene 1 to the cue, and stops before scene 2, which he isn't in", () => {
    expect([...plan.values()].map((j) => [j.kind, j.from, j.to, j.next])).toEqual([
      ["skip", 0, 4, 5],
      ["stop", 5, 10, 11],
    ]);
  });

  it("is nothing with lines that follow each other", () => {
    const close = [q("H1", "s1"), q("x", "s1"), q("H2", "s1")];
    expect(planJumps(close, myStops(close, new Set(["H1", "H2"])), () => undefined, 1).size).toBe(0);
  });

  it("depends on the speed: a long speech skipped at 1× plays through at 2×", () => {
    const speech = [q("H1", "s1"), q("x", "s1"), q("H2", "s1")];
    const stops = myStops(speech, new Set(["H1", "H2"]));
    expect(planJumps(speech, stops, (id) => (id === "x" ? 90_000 : undefined), 1).get(0)?.kind).toBe("skip");
    expect(planJumps(speech, stops, (id) => (id === "x" ? 90_000 : undefined), 2).size).toBe(0);
  });

  it("compares by what it does, not by the numbers measured", () => {
    expect(
      sameJumps(
        plan,
        planJumps(queue, myStops(queue, mine), () => 1500, 1),
      ),
    ).toBe(true);
    expect(sameJumps(plan, new Map())).toBe(false);
    expect(sameJumps(undefined, new Map())).toBe(true);
  });
});

describe("how far ahead, for the prompt", () => {
  it("rounds to minutes", () => {
    expect(aheadText(20_000)).toBe("less than a minute");
    expect(aheadText(70_000)).toBe("about 1 min");
    expect(aheadText(25 * 60_000 + 10_000)).toBe("about 25 min");
  });
});
