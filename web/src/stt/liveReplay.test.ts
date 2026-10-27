import { describe, expect, it } from "vitest";
import takes from "./fixtures/live-takes.json";
import { replayAll, summarizeCheck, summarizeReplay, type ReplayTake } from "./replay";

// Recorded hands-free takes, replayed through the live logic (see replay.ts): spoken lines with
// beats of up to 3.2 s at commas and full stops and mid-clause, mumbled and misheard words, fast
// and slow reads, paraphrased and swapped words, the cue read aloud before the line; and flubs: only
// the cue, the speaker's next line, the line after this one, a wrong cue, nonsense. Each has the
// speech model's real passes at desktop speed and 3× and 5× slower. REPLAY_REPORT=1 prints every take.
const fixtures = takes as unknown as ReplayTake[];
const results = replayAll(fixtures);
const summary = summarizeReplay(results);
const check = summarizeCheck(results);
const bySpeed = (speed: string) => summarizeReplay(results.filter((r) => r.speed === speed));
if (process.env.REPLAY_REPORT) {
  console.table(
    results.map((r) => ({
      take: r.take,
      speed: r.speed,
      expect: r.expect,
      afterEndMs: r.afterEndMs ?? "never",
      flagged: r.flagged,
      cursor: `${r.cursor}/${r.tokens}`,
    })),
  );
  console.log(JSON.stringify({ summary, x1: bySpeed("x1"), x3: bySpeed("x3"), x5: bySpeed("x5"), check }));
}

describe("replayed hands-free takes", () => {
  it("never end before the line is over, however long the beat", () => {
    expect(results.filter((r) => r.expect === "line" && r.afterEndMs !== null && r.afterEndMs < 0).map((r) => `${r.take} ${r.speed}`)).toEqual([]);
  });

  it("always end", () => {
    expect(summary.stuck).toBe(0);
  });

  it("end soon after the last word", () => {
    expect(bySpeed("x1").medianAfterEndMs).toBeLessThanOrEqual(800);
    expect(bySpeed("x3").medianAfterEndMs).toBeLessThanOrEqual(1100);
    expect(bySpeed("x5").medianAfterEndMs).toBeLessThanOrEqual(1600);
    expect(summary.maxAfterEndMs).toBeLessThanOrEqual(2600);
  });

  it("never flag a take of the line, misread or paraphrased", () => {
    expect(check.falseFlags).toEqual([]);
  });

  it("flag every flub", () => {
    expect(check.missedFlubs).toEqual([]);
  });

  it("never light up a line the actor didn't say", () => {
    // A cue or another line read instead may share a word or two with this one, never a run of them.
    expect(results.filter((r) => r.expect === "flub" && r.cursor > 1).map((r) => `${r.take} ${r.speed} ${r.cursor}/${r.tokens}`)).toEqual([]);
  });

  it("cover desktop speed and slower phones, and every kind of take", () => {
    expect(new Set(results.map((r) => r.speed))).toEqual(new Set(["x1", "x3", "x5"]));
    expect(fixtures.filter((f) => (f.expect ?? "line") === "line").length).toBeGreaterThanOrEqual(26);
    expect(fixtures.filter((f) => f.expect === "flub").length).toBeGreaterThanOrEqual(7);
  });
});
