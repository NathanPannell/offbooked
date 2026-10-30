import { describe, expect, it } from "vitest";
// The server's copy, imported on purpose: the plan each side works out is compared below.
import { planCues as serverPlanCues, planStretches as serverStretches } from "../../../backend/src/track/cuePlan";
import { planCues, planStretches, positionOf, SKIP_OVER_LINES, trackStart, TRACK_LINES, TRACK_STRIDE, type PlanLine } from "./cuePlan";
import { trackWindow } from "./listenTrack";
import type { Part, QueueLine } from "./queue";

/** Lines l0, l1… in one scene unless `scenes` says where each scene starts; `directions` are stage directions. */
function script(count: number, opts: { scenes?: number[]; directions?: number[]; words?: Record<number, number> } = {}): QueueLine[] {
  return Array.from({ length: count }, (_, i) => ({
    lineId: `l${i}`,
    sectionId: `s${(opts.scenes ?? []).filter((at) => at <= i).length}`,
    text: Array.from({ length: opts.words?.[i] ?? 5 }, () => "word").join(" "),
    kind: opts.directions?.includes(i) ? ("stage_direction" as const) : ("dialogue" as const),
  }));
}
const mineAt = (...at: number[]) => new Set(at.map((i) => `l${i}`));

describe("the gap rule", () => {
  it("plays through up to 3 lines between two of mine", () => {
    const lines = script(12);
    const plan = planCues(lines, mineAt(0, SKIP_OVER_LINES + 1, 8, 11))!;
    expect(plan.jumps.size).toBe(0);
    expect(plan.skipped).toEqual([]);
    expect(plan.played).toEqual(lines.map((_, i) => i));
  });

  it("skips more than 3, landing on the cue just before my next line", () => {
    const plan = planCues(script(8), mineAt(0, 5, 7))!;
    expect(plan.jumps).toEqual(new Map([[0, 4]]));
    expect(plan.skipped).toEqual([{ from: 1, to: 4 }]);
    expect(plan.played).toEqual([0, 4, 5, 6, 7]);
  });

  it("skips a stretch of 3 lines or fewer that takes more than a minute at a stage pace", () => {
    // A short line (2 s) and a long one at 150 words a minute. The last line is the cue, so it still plays.
    expect(planCues(script(5, { words: { 1: 146 } }), mineAt(0, 3))!.jumps).toEqual(new Map([[0, 2]]));
    expect(planCues(script(5, { words: { 1: 145 } }), mineAt(0, 3))!.jumps.size).toBe(0);
  });

  it("counts only spoken words: bracketed directions and {notes} take no time", () => {
    const lines = script(5);
    lines[1]!.text = `[${"word ".repeat(200)}] {${"word ".repeat(200)}} Hello there.`;
    expect(planCues(lines, mineAt(0, 3))!.jumps.size).toBe(0);
  });

  it("has nothing to skip when the only line between is the cue, however long", () => {
    expect(planCues(script(3, { words: { 1: 1000 } }), mineAt(0, 2))!.jumps.size).toBe(0);
  });

  it("works across scenes, and lands on my line when nothing cues it in its scene", () => {
    const plan = planCues(script(11, { scenes: [6] }), mineAt(0, 6))!;
    expect(plan.jumps).toEqual(
      new Map([
        [0, 6],
        [6, 11],
      ]),
    );
    expect(plan.cues).toEqual([0, 6]);
  });

  it("cues past stage directions, which still play, and not from my own line", () => {
    const lines = script(10, { directions: [7, 8] });
    const plan = planCues(lines, mineAt(0, 9))!;
    expect(plan.cues).toEqual([0, 6]);
    expect(plan.played).toEqual([0, 6, 7, 8, 9]);
    expect(planCues(script(4), mineAt(1, 2))!.cues).toEqual([0, 2]);
  });
});

describe("either end of the play", () => {
  it("starts at the cue of my first line when it is far in", () => {
    const plan = planCues(script(10), mineAt(6, 9))!;
    expect(plan.played[0]).toBe(5);
    expect(plan.skipped[0]).toEqual({ from: 0, to: 5 });
    expect(plan.jumps.has(-1)).toBe(false);
    // Close to the start, the opening plays.
    expect(planCues(script(10), mineAt(3, 6, 9))!.played[0]).toBe(0);
  });

  it("ends after my last line when the rest is long, and plays out a short tail", () => {
    const plan = planCues(script(10), mineAt(0, 3))!;
    expect(plan.jumps.get(3)).toBe(10);
    expect(plan.played).toEqual([0, 1, 2, 3]);
    expect(planCues(script(7), mineAt(0, 3))!.played).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });
});

describe("hearing everything", () => {
  it("leaves nothing out and keeps the cues for ⏮ and ⏭", () => {
    const lines = script(20);
    const plan = planCues(lines, mineAt(2, 15), false)!;
    expect(plan.jumps.size).toBe(0);
    expect(plan.played).toHaveLength(20);
    expect(plan.cues).toEqual([1, 14]);
  });

  it("no lines of mine: no plan", () => {
    expect(planCues(script(5), new Set())).toBeNull();
  });
});

describe("the stretches of a plan", () => {
  it("run over the lines that play, not script lines", () => {
    const lines = script(1000);
    const plan = planCues(lines, mineAt(...Array.from({ length: 200 }, (_, i) => i * 2), 990))!;
    expect(plan.played.length).toBeLessThan(TRACK_LINES * 2);
    const stretches = planStretches(lines, plan);
    expect(stretches.map((s) => s.start)).toEqual([0, TRACK_STRIDE].slice(0, stretches.length));
    expect(new Set(stretches.flatMap((s) => s.lineIds)).size).toBe(plan.played.length);
  });

  it("finds a line's place among the lines that play, or the next that does", () => {
    const plan = planCues(script(8), mineAt(0, 5, 7))!;
    expect([0, 1, 3, 4, 5, 7].map((i) => positionOf(plan, i))).toEqual([0, 1, 1, 1, 2, 4]);
    expect(positionOf(null, 7)).toBe(7);
    expect(positionOf(null, -1)).toBe(0);
  });

  it("names a jump only when the line it lands on is in the same file", () => {
    const lines = script(1200);
    const every = Array.from({ length: 150 }, (_, i) => i * 2);
    const plan = planCues(lines, mineAt(...every, 900, 901 + TRACK_LINES - 2))!;
    for (const { lineIds, skips } of planStretches(lines, plan)) expect(skips.includes(lineIds[lineIds.length - 1]!)).toBe(false);
  });
});

describe("the player asks for exactly what the server plans", () => {
  // A seeded mix: scenes, stage directions, long speeches, parts of every size, shared lines aside.
  function generate(seed: number) {
    let x = seed;
    const random = (n: number) => {
      x = (x * 1664525 + 1013904223) % 4294967296;
      return x % n;
    };
    const lines: PlanLine[] = [];
    const mine = new Set<string>();
    const size = 50 + random(1100);
    const density = 2 + random(30);
    for (let i = 0, section = 0; i < size; i++) {
      if (random(40) === 0) section++;
      const kind = random(9) === 0 ? "stage_direction" : "dialogue";
      lines.push({ lineId: `l${i}`, sectionId: `s${section}`, kind, text: "word ".repeat(1 + random(random(12) === 0 ? 200 : 25)) });
      if (kind === "dialogue" && random(density) === 0) mine.add(`l${i}`);
    }
    return { lines, mine };
  }

  it.each(Array.from({ length: 40 }, (_, i) => [i * 7919 + 3]))("seed %i", (seed) => {
    const { lines, mine } = generate(seed);
    const server = serverPlanCues(lines, mine);
    const player = planCues(lines, mine);
    expect(player?.played).toEqual(server?.played);
    if (!player) return;
    const part: Part = { mine, mode: "pause", plan: player };
    const built = serverStretches(lines, server).map(({ start, lineIds, skips }) => {
      const theirs = lineIds.filter((id) => mine.has(id));
      return { start, req: { lineIds, mine: theirs, mode: theirs.length ? "pause" : "read", ...(skips.length ? { skips } : {}) } };
    });
    const count = player.played.length;
    // Wherever the listener is, the stretch they ask for is one built ahead, to the letter.
    for (const at of [0, 1, count >> 1, count - 1, ...built.map((b) => b.start)]) {
      const start = trackStart(at, count);
      expect(trackWindow(lines as QueueLine[], start, part)).toEqual(built.find((b) => b.start === start)!.req);
    }
  });
});
