import { describe, expect, it } from "vitest";
import { backoffMs, enqueue, latestForLine, MAX_BACKOFF_MS, nextDue, nextWakeAt, transition, uploadState, type UploadItem } from "./queue";

function item(overrides: Partial<UploadItem> = {}): UploadItem {
  return {
    takeId: "t1",
    token: "tok",
    lineId: "l1",
    mime: "audio/webm",
    durationMs: 1000,
    createdAt: 0,
    status: "queued",
    attempts: 0,
    nextAttemptAt: 0,
    error: null,
    ...overrides,
  };
}

describe("transition", () => {
  it("goes queued, uploading, saved", () => {
    const uploading = transition(item(), { type: "begin" });
    expect(uploading).toMatchObject({ status: "uploading", attempts: 1 });
    expect(transition(uploading, { type: "succeeded" }).status).toBe("saved");
  });

  it("requeues retryable failures with backoff", () => {
    const uploading = transition(item(), { type: "begin" });
    const failed = transition(uploading, { type: "failed", retryable: true, message: "offline", now: 100 });
    expect(failed).toMatchObject({ status: "queued", error: "offline", nextAttemptAt: 100 + backoffMs(1) });
  });

  it("never gives up on a take that can still land", () => {
    // The server refused every take for hours: the takes stayed queued, a minute apart at most.
    const uploading = item({ status: "uploading", attempts: 500 });
    const after = transition(uploading, { type: "failed", retryable: true, message: "server", code: "storage_unavailable", now: 0 });
    expect(after).toMatchObject({ status: "queued", errorCode: "storage_unavailable", nextAttemptAt: MAX_BACKOFF_MS });
  });

  it("waits as long as the server asks", () => {
    const uploading = item({ status: "uploading", attempts: 1 });
    const after = transition(uploading, { type: "failed", retryable: true, message: "slow down", code: "rate_limited", now: 10, retryAfterMs: 90_000 });
    expect(after.nextAttemptAt).toBe(90_010);
  });

  it("keeps the last error showing while it tries again, and clears it once saved", () => {
    const waiting = item({ attempts: 2, error: "Can't reach Offbooked.", errorCode: "network" });
    const again = transition(waiting, { type: "begin" });
    expect(again).toMatchObject({ status: "uploading", attempts: 3, errorCode: "network" });
    expect(transition(again, { type: "succeeded" })).toMatchObject({ status: "saved", error: null, errorCode: null });
  });

  it("fails at once on errors a retry can't fix", () => {
    const uploading = item({ status: "uploading", attempts: 1 });
    expect(transition(uploading, { type: "failed", retryable: false, message: "too big", now: 0 })).toMatchObject({
      status: "failed",
      error: "too big",
    });
  });

  it("retry now skips a queued take's wait", () => {
    expect(transition(item({ nextAttemptAt: 60_000 }), { type: "retry", now: 5 }).nextAttemptAt).toBe(5);
    expect(transition(item({ status: "uploading" }), { type: "retry", now: 5 }).status).toBe("uploading");
  });

  it("retries a failed take from scratch", () => {
    const failed = item({ status: "failed", attempts: 6, error: "x" });
    expect(transition(failed, { type: "retry", now: 50 })).toMatchObject({
      status: "queued",
      attempts: 0,
      nextAttemptAt: 50,
    });
  });

  it("resumes an interrupted upload after reload", () => {
    expect(transition(item({ status: "uploading" }), { type: "resume", now: 9 })).toMatchObject({
      status: "queued",
      nextAttemptAt: 9,
    });
    expect(transition(item({ status: "saved" }), { type: "resume", now: 9 }).status).toBe("saved");
  });

  it("doesn't make a waiting take sit out an earlier visit's backoff", () => {
    expect(transition(item({ nextAttemptAt: 60_000, attempts: 3 }), { type: "resume", now: 9 }).nextAttemptAt).toBe(9);
  });

  it("gives a failed take another go on the next launch", () => {
    // Takes an older app gave up on (or the server refused) go up once whatever stopped them is fixed.
    expect(transition(item({ status: "failed", attempts: 6, error: "x" }), { type: "resume", now: 9 })).toMatchObject({
      status: "queued",
      nextAttemptAt: 9,
    });
  });

  it("skips the backoff wait when the connection comes back", () => {
    expect(transition(item({ nextAttemptAt: 10_000 }), { type: "online", now: 5 }).nextAttemptAt).toBe(5);
  });

  it("ignores events that don't apply", () => {
    const saved = item({ status: "saved" });
    expect(transition(saved, { type: "begin" })).toBe(saved);
    expect(transition(saved, { type: "failed", retryable: true, message: "x", now: 0 })).toBe(saved);
  });
});

describe("backoffMs", () => {
  it("doubles and caps", () => {
    expect([1, 2, 3, 4, 10].map((n) => backoffMs(n))).toEqual([1000, 2000, 4000, 8000, 60_000]);
    expect(backoffMs(1, 1)).toBe(1200);
    expect(backoffMs(1, -1)).toBe(800);
  });
});

describe("uploadState", () => {
  it("tells waiting for a connection from a server refusing the take", () => {
    expect(uploadState(item())).toBe("saving");
    expect(uploadState(item({ status: "uploading" }))).toBe("saving");
    expect(uploadState(item({ errorCode: "network" }))).toBe("offline");
    expect(uploadState(item({ status: "uploading", errorCode: "timeout" }))).toBe("offline");
    expect(uploadState(item({ errorCode: "storage_unavailable" }))).toBe("retrying");
    expect(uploadState(item({ status: "failed", errorCode: "take_limit" }))).toBe("failed");
    expect(uploadState(item({ status: "saved" }))).toBe("saved");
  });
});

describe("queue", () => {
  it("supersedes waiting takes for the same line, but not one already uploading", () => {
    const items = [
      item({ takeId: "a", status: "uploading" }),
      item({ takeId: "b", status: "queued" }),
      item({ takeId: "c", status: "failed" }),
      item({ takeId: "d", lineId: "l2" }),
    ];
    const result = enqueue(items, item({ takeId: "e", createdAt: 5 }));
    expect(result.superseded).toEqual(["b", "c"]);
    expect(result.items.map((i) => i.takeId)).toEqual(["a", "d", "e"]);
  });

  it("uploads one at a time, oldest first, once due", () => {
    const items = [item({ takeId: "new", createdAt: 2 }), item({ takeId: "old", createdAt: 1 }), item({ takeId: "later", nextAttemptAt: 99 })];
    expect(nextDue(items, 10)?.takeId).toBe("old");
    expect(nextDue([...items, item({ takeId: "busy", status: "uploading" })], 10)).toBeNull();
    expect(nextDue([item({ nextAttemptAt: 99 })], 10)).toBeNull();
  });

  it("knows when to wake up next", () => {
    expect(nextWakeAt([item({ nextAttemptAt: 30 }), item({ nextAttemptAt: 20 }), item({ status: "failed", nextAttemptAt: 1 })])).toBe(20);
    expect(nextWakeAt([item({ status: "saved" })])).toBeNull();
  });

  it("reports the newest take for a line", () => {
    const items = [item({ takeId: "a", createdAt: 1 }), item({ takeId: "b", createdAt: 3 }), item({ takeId: "c", lineId: "x", createdAt: 9 })];
    expect(latestForLine(items, "tok", "l1")?.takeId).toBe("b");
    expect(latestForLine(items, "other", "l1")).toBeNull();
  });
});
