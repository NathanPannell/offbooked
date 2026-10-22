import { IDBFactory } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TakePartResult, TakeUploadResult } from "../api/actor";
import { ApiError } from "../api/client";
import { uploadState, type UploadItem } from "./queue";
import { MemoryTakeStore, openTakeStore, type TakeStore } from "./store";
import { stallTimeoutMs, Uploader, type SendTake, type UploaderOptions } from "./uploader";

const landed = (item: UploadItem) => ({ take: { id: `server-${item.takeId}` }, linesRecorded: 1, linesTotal: 2 }) as unknown as TakeUploadResult;
const take = (lineId = "l1") => ({ token: "tok", lineId, audio: new Blob([new Uint8Array([1, 2, 3])], { type: "audio/webm" }), durationMs: 900 });

/** Answers like fetch does when the network drops the request silently: never, until it's aborted. */
const hang: SendTake = (_item, _body, _part, signal) =>
  new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));

const refused = () => Promise.reject(new ApiError(503, "storage_unavailable", "Offbooked can't store recordings right now.", null));

const uploaders: Uploader[] = [];
function uploader(send: SendTake, opts: UploaderOptions = {}, store: TakeStore = new MemoryTakeStore()) {
  const up = new Uploader({ openStore: async () => ({ store, persistent: true }), send, random: () => 0.5, ...opts });
  uploaders.push(up);
  return up;
}

const statusOf = (up: Uploader) => up.getItems().map((i) => i.status);

beforeEach(() => {
  vi.stubGlobal("window", new EventTarget());
});
afterEach(() => {
  uploaders.splice(0).forEach((u) => u.dispose());
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the uploader", () => {
  it("gives a stalled upload up after its timeout, says so, and sends it again", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const up = uploader(
      (item, body, part, signal) => {
        calls++;
        return calls === 1 ? hang(item, body, part, signal) : Promise.resolve(landed(item));
      },
      { stallTimeoutMs: () => 5000 },
    );
    const saved = vi.fn();
    up.onSaved(saved);
    await up.add(take());
    await vi.advanceTimersByTimeAsync(0);
    expect(statusOf(up)).toEqual(["uploading"]);

    await vi.advanceTimersByTimeAsync(5000);
    // Before, this take said "Saving…" for good and held up every take behind it.
    const waiting = up.getItems()[0]!;
    expect(waiting).toMatchObject({ status: "queued", errorCode: "timeout", error: "The upload stalled. Trying again." });
    expect(uploadState(waiting)).toBe("offline");

    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toBe(2);
    expect(saved).toHaveBeenCalledOnce();
  });

  it("sends one request at a time while the server refuses takes, never gives up, and catches up once it's back", async () => {
    vi.useFakeTimers();
    let down = true;
    let calls = 0;
    const up = uploader((item) => {
      calls++;
      return down ? refused() : Promise.resolve(landed(item));
    });
    for (const line of ["l1", "l2", "l3", "l4", "l5"]) await up.add(take(line));

    // Ten minutes of a server that won't store recordings. The old queue sent every waiting take six
    // times in about half a minute, which also used up the rate limit for when the server came back.
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(calls).toBeLessThan(20);
    expect(statusOf(up).every((s) => s === "queued")).toBe(true);
    expect(up.getItems().map(uploadState)).toContain("retrying");

    down = false;
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(up.getItems().filter((i) => i.status !== "saved")).toEqual([]);
  });

  it("waits as long as the server asks after a 429", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const up = uploader((item) => {
      calls++;
      return calls === 1 ? Promise.reject(new ApiError(429, "rate_limited", "Slow down.", null, 120_000)) : Promise.resolve(landed(item));
    });
    await up.add(take());
    await vi.advanceTimersByTimeAsync(119_000);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(calls).toBe(2);
    expect(statusOf(up)).toEqual(["saved"]);
  });

  it("tries again at once when asked, skipping the wait", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const up = uploader((item) => (++calls < 4 ? refused() : Promise.resolve(landed(item))));
    await up.add(take());
    await vi.advanceTimersByTimeAsync(3000 + 2000);
    expect(calls).toBe(3);
    up.retryAll();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toBe(4);
    expect(statusOf(up)).toEqual(["saved"]);
  });

  it("stops at once on a refusal a retry can't fix", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const up = uploader(() => {
      calls++;
      return Promise.reject(new ApiError(409, "take_limit", "You've recorded this line 25 times.", null));
    });
    await up.add(take());
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toBe(1);
    expect(up.getItems()[0]).toMatchObject({ status: "failed", errorCode: "take_limit" });
  });

  it("keeps a take it couldn't upload through a reload, and sends it when the page opens again", async () => {
    // The phone was offline, then the page crashed or was closed: the take waits on the device.
    const factory = new IDBFactory();
    const offline: SendTake = () => Promise.reject(new ApiError(0, "network", "Can't reach Offbooked.", null));
    const first = new Uploader({ openStore: () => openTakeStore(factory), send: offline });
    uploaders.push(first);
    const takeId = await first.add(take());
    await vi.waitFor(() => expect(first.getItems()[0]?.errorCode).toBe("network"), { timeout: 5000 });
    first.dispose();

    const sent: string[] = [];
    const second = new Uploader({
      openStore: () => openTakeStore(factory),
      send: async (item, body) => {
        sent.push(`${item.takeId}:${await body.text()}`);
        return landed(item) as TakeUploadResult | TakePartResult;
      },
    });
    uploaders.push(second);
    await vi.waitFor(() => expect(statusOf(second)).toEqual(["saved"]), { timeout: 5000 });
    expect(sent).toEqual([`${takeId}:\u0001\u0002\u0003`]);
    // Landed takes leave the device.
    const { store } = await openTakeStore(factory);
    await vi.waitFor(async () => expect(await store.list()).toEqual([]), { timeout: 5000 });
  });

  it("plays back a take still waiting on the device", async () => {
    const up = uploader(() => refused());
    const takeId = await up.add(take());
    const blob = await up.audio(takeId);
    expect(blob?.type).toBe("audio/webm");
    expect(new Uint8Array(await blob!.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    expect(await up.audio("gone")).toBeNull();
  });

  it("still uploads a take the device wouldn't store", async () => {
    const full = new MemoryTakeStore();
    full.put = () => Promise.reject(new DOMException("full", "QuotaExceededError"));
    const bodies: string[] = [];
    const up = uploader(
      async (item, body) => {
        bodies.push(await body.text());
        return landed(item);
      },
      {},
      full,
    );
    await up.add(take());
    await vi.waitFor(() => expect(statusOf(up)).toEqual(["saved"]));
    expect(bodies).toEqual(["\u0001\u0002\u0003"]);
  });
});

describe("stallTimeoutMs", () => {
  it("allows for the body at a weak signal's speed", () => {
    expect(stallTimeoutMs(0)).toBe(30_000);
    expect(stallTimeoutMs(160 * 1024)).toBe(40_000);
  });
});
