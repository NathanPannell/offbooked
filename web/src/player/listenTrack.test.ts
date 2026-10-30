import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ListenTrack, ListenTrackRequest } from "../api/types";
import type { Jump } from "./autoSkip";
import {
  lockNote,
  MAX_TRIES,
  needsTrack,
  POLL_MS,
  pollTrack,
  REFRESH_LINES,
  RETRY_FAILED_MS,
  stopToFetch,
  stretchToAsk,
  TRACK_LINES,
  TRACK_STRIDE,
  trackStart,
  trackWindow,
  windowSpan,
  type Poll,
} from "./listenTrack";
import { TRACK_URL_FRESH_MS } from "./engine";
import { nextIndex, NO_PART, sameLines, samePart, type Part, type QueueLine } from "./queue";

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

describe("the stretch asked for, with Skip to my cues", () => {
  const gap = { lines: 4, audioMs: 90_000, pauseMs: 1_400, scenes: 0 };
  // Mine: l0, l5, l9. After l0 a skip lands on l4 (l5's cue); after l5 a stop before l9 (cue l8).
  const part: Part = {
    mine: new Set(["l0", "l5", "l9"]),
    mode: "read",
    jumps: new Map([
      [0, { kind: "skip", from: 0, to: 4, next: 5, gap }],
      [5, { kind: "stop", from: 5, to: 8, next: 9, gap }],
    ]),
  };

  it("leaves out what a skip leaves out, says where the sound goes, and ends at a stop", () => {
    const req = trackWindow(queue, 0, part);
    expect(req).toEqual({ lineIds: ["l0", "l4", "l5"], mine: ["l0", "l5"], mode: "read", skips: ["l0"] });
    expect(windowSpan(queue, 0, part, req)).toEqual({ start: 0, end: 6, stop: part.jumps!.get(5) });
  });

  it("after the stop, runs from the jump's cue", () => {
    const req = trackWindow(queue, 8, part);
    expect(req).toEqual({ lineIds: ["l8", "l9"], mine: ["l9"], mode: "read" });
    expect(windowSpan(queue, 8, part, req)).toEqual({ start: 8, end: 10, stop: null });
  });

  it("is a different track from the same lines without it", () => {
    expect(samePart(part, { ...part, jumps: undefined })).toBe(false);
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
    const asked = { queue: long, part, start: 0, end: 300, stop: null, at: Date.now() };
    expect(stretchToAsk(asked, long, part, 200, 299)).toBeNull();
    // 40 lines before its end: the next stretch, which starts there.
    expect(stretchToAsk(asked, long, part, 260, 299)).toBe(260);
    // A jump back into a track the engine already holds asks for nothing.
    expect(stretchToAsk({ ...asked, start: 260, end: 560 }, long, part, 100, 299)).toBeNull();
    // A change of part or mode asks again for the same stretch.
    expect(stretchToAsk(asked, long, { ...part, mode: "skip" }, 10, 299)).toBe(0);
    expect(stretchToAsk(asked, long, NO_PART, 10, 299)).toBe(0);
    // Asked on open and played hours later: the same stretch again, for a fresh URL.
    expect(stretchToAsk(asked, long, part, 10, 299, asked.at + TRACK_URL_FRESH_MS - 1)).toBeNull();
    expect(stretchToAsk(asked, long, part, 10, 299, asked.at + TRACK_URL_FRESH_MS + 1)).toBe(0);
  });
});

describe("the stretches a listen-through asks for, walking the whole play", () => {
  const long: QueueLine[] = Array.from({ length: 814 }, (_, i) => ({ lineId: `l${i}`, sectionId: "s", text: "Words." }));
  const gap = { lines: 0, audioMs: 0, pauseMs: 0, scenes: 0 };
  const skip = (from: number, to: number): [number, Jump] => [from, { kind: "skip", from, to, next: to + 1, gap }];
  const stop = (from: number, to: number): [number, Jump] => [from, { kind: "stop", from, to, next: to + 1, gap }];

  /** Plays from the top, re-running the hook's decision at every line (twice: a re-render asks nothing), as far as the part goes. */
  function walk(part: Part) {
    const asks: { from: number; req: ListenTrackRequest }[] = [];
    const fetchedAhead: number[] = [];
    let asked: Parameters<typeof stretchToAsk>[0] = null;
    const look = (i: number) => {
      const reach = asked && i >= asked.start && i < asked.end ? asked.end - 1 : null;
      const from = stretchToAsk(asked, long, part, i, reach);
      if (from === null) return;
      const req = trackWindow(long, from, part);
      asks.push({ from, req });
      asked = { queue: long, part, ...windowSpan(long, from, part, req), at: Date.now() };
    };
    for (let i: number | null = 0; i !== null;) {
      look(i);
      look(i);
      expect(asked!.start).toBeLessThanOrEqual(i);
      expect(asked!.end).toBeGreaterThan(i);
      const after = stopToFetch(asked, i);
      if (after !== null && !fetchedAhead.includes(after)) fetchedAhead.push(after);
      const jump: Jump | undefined = part.jumps?.get(i);
      i = jump?.kind === "stop" ? jump.to : nextIndex(long, i, part);
    }
    return { asks, fetchedAhead };
  }

  it.each([
    ["no part", NO_PART],
    ["a part", { mine: new Set(["l3", "l400"]), mode: "pause" as const }],
    ["Skip to my cues on with nothing to skip", { mine: new Set(["l3", "l400"]), mode: "pause" as const, jumps: new Map() }],
  ])("with %s, one request per stretch of the grid, exactly as the server builds them ahead", (_name, part: Part) => {
    const { asks, fetchedAhead } = walk(part);
    expect(asks.map((a) => a.from)).toEqual([0, 260, 520]);
    expect(fetchedAhead).toEqual([]);
    for (const { from, req } of asks) {
      const lineIds = long.slice(from, from + TRACK_LINES).map((l) => l.lineId);
      const mine = lineIds.filter((id) => part.mine?.has(id));
      // No `skips` key at all, and the mode only where the stretch has their lines: the server's plannedTracks.
      expect(req).toEqual({ lineIds, mine, mode: mine.length ? part.mode : "read" });
    }
  });

  it("with skips and stops, stretches start at the listener's line and are never asked for twice", () => {
    const part: Part = {
      mine: new Set(["l10", "l100", "l450"]),
      mode: "pause",
      jumps: new Map([skip(10, 60), stop(100, 400), skip(450, 700)]),
    };
    const { asks, fetchedAhead } = walk(part);
    const starts = asks.map((a) => a.from);
    // From the top to the stop; after the stop, from where it lands, to the end of the play.
    expect(starts).toEqual([0, 400]);
    // Not the grid's 260: that is on the far side of the stop.
    expect(asks[0]!.req.lineIds.at(-1)).toBe("l100");
    expect(asks[0]!.req.skips).toEqual(["l10"]);
    expect(asks[1]!.req.skips).toEqual(["l450"]);
    expect(fetchedAhead).toEqual([400]);
  });

  it("past a stretch that doesn't end at a stop, the next one starts where the listener is, once", () => {
    const part: Part = { mine: new Set(["l10"]), mode: "read", jumps: new Map([skip(10, 40)]) };
    const { asks, fetchedAhead } = walk(part);
    expect(asks.map((a) => a.from)).toEqual([0, 289, 549]);
    expect(fetchedAhead).toEqual([]);
  });

  it("held at a stop, the stretch to ask for is the one fetched ahead", () => {
    const jump = stop(100, 400)[1];
    const part: Part = { mine: new Set(["l100"]), mode: "pause", jumps: new Map([[100, jump]]) };
    const req = trackWindow(long, 0, part);
    const asked = { queue: long, part, ...windowSpan(long, 0, part, req), at: Date.now() };
    expect(asked).toMatchObject({ end: 101, stop: jump });
    expect(stopToFetch(asked, 60)).toBeNull();
    expect(stopToFetch(asked, 61)).toBe(400);
    // RunThroughPlayer passes the held line's jump target as the index.
    expect(stretchToAsk(asked, long, part, 400, null)).toBe(400);
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
