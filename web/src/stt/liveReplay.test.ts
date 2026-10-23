import { describe, expect, it } from "vitest";
import takes from "./fixtures/live-takes.json";
import { replayAll, summarizeReplay, type ReplayTake } from "./replay";

// Recorded hands-free takes, replayed through the live logic (see replay.ts): spoken lines with
// beats of up to 3.2 s at commas and full stops and mid-clause, mumbled and misheard words, fast
// and slow reads, each with the speech model's real passes at desktop speed and 3× and 5× slower.
// REPLAY_REPORT=1 prints every take.
const fixtures = takes as unknown as ReplayTake[];
const results = replayAll(fixtures);
const summary = summarizeReplay(results);
if (process.env.REPLAY_REPORT) {
  console.table(results.map((r) => ({ take: r.take, speed: r.speed, afterEndMs: r.afterEndMs ?? "never", cursor: `${r.cursor}/${r.tokens}` })));
  console.log(JSON.stringify(summary));
}

describe("replayed hands-free takes", () => {
  it("never end before the line is over, however long the beat", () => {
    expect(results.filter((r) => r.afterEndMs !== null && r.afterEndMs < 0).map((r) => `${r.take} ${r.speed}`)).toEqual([]);
  });

  it("always end", () => {
    expect(summary.stuck).toBe(0);
  });

  it("end soon after the last word", () => {
    expect(summary.medianAfterEndMs).toBeLessThanOrEqual(1000);
    expect(summary.maxAfterEndMs).toBeLessThanOrEqual(2600);
  });

  it("cover desktop speed and slower phones", () => {
    expect(new Set(results.map((r) => r.speed))).toEqual(new Set(["x1", "x3", "x5"]));
    expect(fixtures.length).toBeGreaterThanOrEqual(19);
  });
});
