import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ListenTrack } from "../api/types";
import {
  lockNote,
  MAX_TRIES,
  needsTrack,
  POLL_MS,
  pollTrack,
  REFRESH_LINES,
  RETRY_FAILED_MS,
  stretchToAsk,
  TRACK_LINES,
  TRACK_STRIDE,
  trackStart,
  trackWindow,
  type Poll,
} from "./listenTrack";
import { NO_PART, sameLines, samePart, type QueueLine } from "./queue";

const queue: QueueLine[] = Array.from({ length: 10 }, (_, i) => ({ lineId: `l${i}`, sectionId: i < 5 ? "s1" : "s2", text: "Some words." }));

describe("the stretch asked for", () => {
  it("runs from the current line in playback order, up to the most a track holds", () => {
    expect(trackWindow(queue, 3, NO_PART, 4)).toEqual({ lineIds: ["l3", "l4", "l5", "l6"], mine: [], mode: "read" });
    expect(trackWindow(queue, 8, NO_PART).lineIds).toEqual(["l8", "l9"]);
  });

  it("names the listener's lines in it and their mode; with none in it the mode doesn't matter", () => {
    const part = { mine: new Set(["l4", "l9"]), mode: "pause" as const };
    expect(trackWindow(queue, 2, part, 4)).toEqual({ lineIds: ["l2", "l3", "l4", "l5"], mine: ["l4"], mode: "pause" });
    // So the same stretch heard by someone with no lines in it is the same track.
    expect(trackWindow(queue, 5, part, 4)).toEqual({ lineIds: ["l5", "l6", "l7", "l8"], mine: [], mode: "read" });
  });
});

describe("when to ask", () => {
  it("asks when no track covers the line, or the one that does ends soon (unless it runs to the end)", () => {
    expect(needsTrack(null, 0, 500)).toBe(true);
    expect(needsTrack(299, 0, 500)).toBe(false);
    expect(needsTrack(299, 299 - REFRESH_LINES + 1, 500)).toBe(true);
    expect(needsTrack(499, 480, 500)).toBe(false);
  });
});

describe("where a stretch starts", () => {
  it("every 260 lines, the ones the server builds ahead, the last one running to the end", () => {
    expect(TRACK_STRIDE).toBe(TRACK_LINES - REFRESH_LINES);
    expect([0, 259, 260, 519, 520, 790, 813].map((i) => trackStart(i, 814))).toEqual([0, 0, 260, 260, 520, 520, 520]);
    expect(trackStart(250, 290)).toBe(0);
    for (const count of [1, 300, 301, 814, 1806])
      for (let i = 0; i < count; i++) {
        const start = trackStart(i, count);
        expect(i - start).toBeLessThan(TRACK_LINES);
        expect(start % TRACK_STRIDE).toBe(0);
      }
  });

  it("is asked for from the line the play is at before it starts, and again only when the stretch or the listen changes", () => {
    const long: QueueLine[] = Array.from({ length: 814 }, (_, i) => ({ lineId: `l${i}`, sectionId: "s", text: "Words." }));
    const part = { mine: new Set(["l3"]), mode: "pause" as const };
    // Opened, nothing asked yet: the opening stretch, whatever the line.
    expect(stretchToAsk(null, long, part, 0, null)).toBe(0);
    expect(stretchToAsk(null, long, part, 140, null)).toBe(0);
    const asked = { queue: long, part, start: 0 };
    expect(stretchToAsk(asked, long, part, 200, 299)).toBeNull();
    // 40 lines before its end: the next stretch, which starts there.
    expect(stretchToAsk(asked, long, part, 260, 299)).toBe(260);
    // A jump back into a track the engine already holds asks for nothing.
    expect(stretchToAsk({ ...asked, start: 260 }, long, part, 100, 299)).toBeNull();
    // A change of part or mode asks again for the same stretch.
    expect(stretchToAsk(asked, long, { ...part, mode: "skip" }, 10, 299)).toBe(0);
    expect(stretchToAsk(asked, long, NO_PART, 10, 299)).toBe(0);
  });
});

describe("what a track still fits", () => {
  it("the same lines in the same order, however often the script is reloaded", () => {
    expect(
      sameLines(
        queue,
        queue.map((l) => ({ ...l })),
      ),
    ).toBe(true);
    expect(sameLines(queue, queue.slice(1))).toBe(false);
    expect(sameLines(queue, [...queue].reverse())).toBe(false);
  });

  it("the same lines of mine and the same mode on them; the mode doesn't matter with none", () => {
    expect(samePart({ mine: new Set(["a", "b"]), mode: "pause" }, { mine: new Set(["b", "a"]), mode: "pause" })).toBe(true);
    expect(samePart({ mine: new Set(["a"]), mode: "pause" }, { mine: new Set(["a"]), mode: "skip" })).toBe(false);
    expect(samePart({ mine: new Set(["a"]), mode: "pause" }, { mine: new Set(["b"]), mode: "pause" })).toBe(false);
    expect(samePart(NO_PART, { mine: new Set(), mode: "pause" })).toBe(true);
    expect(samePart(NO_PART, { mine: new Set(["a"]), mode: "read" })).toBe(false);
  });
});

describe("asking for a stretch", () => {
  const req = { lineIds: ["l0"], mine: [], mode: "read" as const };
  const ready: ListenTrack = { status: "ready", url: "https://files.test/t.m4a", durationMs: 1000, items: [] };
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  // Answers each request with the next of `answers` (an Error rejects), and counts them.
  const asker = (...answers: (ListenTrack | Error)[]) => {
    const ask = vi.fn(async () => {
      const next = answers.shift() ?? answers.at(-1) ?? { status: "failed" };
      if (next instanceof Error) throw next;
      return { track: next };
    });
    return ask;
  };

  it("asks again while it builds, then hands over the ready track and stops", async () => {
    const ask = asker({ status: "building" }, { status: "building" }, ready);
    const on = { ready: vi.fn(), failed: vi.fn() };
    pollTrack({ cancelled: false }, ask, req, on);
    await vi.advanceTimersByTimeAsync(POLL_MS * 2);
    expect(on.ready).toHaveBeenCalledWith(ready);
    await vi.advanceTimersByTimeAsync(RETRY_FAILED_MS * 5);
    expect(ask).toHaveBeenCalledTimes(3);
  });

  it("waits as long as the server does after a failure, and gives up after a few tries", async () => {
    const ask = asker({ status: "failed" }, new Error("offline"), { status: "failed" });
    const on = { ready: vi.fn(), failed: vi.fn() };
    const poll: Poll = { cancelled: false };
    pollTrack(poll, ask, req, on);
    await vi.advanceTimersByTimeAsync(RETRY_FAILED_MS - 1);
    expect(ask).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(RETRY_FAILED_MS * 20);
    expect(ask).toHaveBeenCalledTimes(MAX_TRIES);
    expect(on.failed).toHaveBeenCalledTimes(MAX_TRIES);
    expect(on.ready).not.toHaveBeenCalled();
    // Still the stretch in hand, so the player doesn't ask for it again from the next line.
    expect(poll.cancelled).toBe(false);
  });

  it("stops at once when cancelled", async () => {
    const ask = asker({ status: "building" });
    const poll: Poll = { cancelled: false };
    pollTrack(poll, ask, req, { ready: vi.fn(), failed: vi.fn() });
    await vi.advanceTimersByTimeAsync(0);
    poll.cancelled = true;
    clearTimeout(poll.timer);
    await vi.advanceTimersByTimeAsync(POLL_MS * 10);
    expect(ask).toHaveBeenCalledTimes(1);
  });
});

describe("the note about the screen lock", () => {
  const base = { playing: true, interrupted: false, status: "building" as const, onTrack: false, covered: false };

  it("says when it can play locked, and to keep the screen on until then", () => {
    expect(lockNote({ ...base, status: "ready", onTrack: true, covered: true })).toBe("Ready to play with the screen locked.");
    expect(lockNote(base)).toMatch(/^Getting ready to play with the screen locked… Keep the screen on/);
    // Ready, and the engine moves onto it at the next line.
    expect(lockNote({ ...base, status: "ready", covered: true })).toMatch(/^Getting ready/);
  });

  it("is honest when this stretch can't play locked: a failed track, or one the engine dropped", () => {
    expect(lockNote({ ...base, status: "failed" })).toBe("This part can't play with the screen locked yet. Keep the screen on.");
    expect(lockNote({ ...base, status: "ready", covered: false })).toBe("This part can't play with the screen locked yet. Keep the screen on.");
  });

  it("says the phone stopped it, back on the page; says nothing paused, or in the app", () => {
    expect(lockNote({ ...base, playing: false, interrupted: true })).toMatch(/^The phone stopped the play while the screen was off/);
    expect(lockNote({ ...base, playing: false })).toBe("");
    expect(lockNote({ ...base, status: "off" })).toBe("");
  });
});
