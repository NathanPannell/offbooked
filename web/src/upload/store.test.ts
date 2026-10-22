import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import type { UploadItem } from "./queue";
import { IdbTakeStore, openDb, openTakeStore } from "./store";

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

const bytes = (...values: number[]) => new Uint8Array(values).buffer;

/** A database as version 1 of the app left it: each take's audio inside its row. */
function openV1(factory: IDBFactory, rows: (UploadItem & { audio: ArrayBuffer })[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = factory.open("offbooked", 1);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore("takes", { keyPath: "takeId" });
      for (const row of rows) store.put(row);
    };
    request.onsuccess = () => {
      request.result.close();
      resolve();
    };
    request.onerror = () => reject(request.error);
  });
}

describe("the take store", () => {
  it("keeps a take and its audio until it's removed", async () => {
    const { store, persistent } = await openTakeStore(new IDBFactory());
    expect(persistent).toBe(true);
    await store.put(item(), bytes(1, 2, 3));
    expect(await store.list()).toEqual([item()]);
    expect(new Uint8Array((await store.audio("t1"))!)).toEqual(new Uint8Array([1, 2, 3]));
    await store.remove("t1");
    expect(await store.list()).toEqual([]);
    expect(await store.audio("t1")).toBeNull();
  });

  it("changes a take's status without touching its audio, and never brings a removed take back", async () => {
    const { store } = await openTakeStore(new IDBFactory());
    await store.put(item(), bytes(7));
    await store.update(item({ status: "uploading", attempts: 1 }));
    expect(await store.list()).toEqual([item({ status: "uploading", attempts: 1 })]);
    expect(new Uint8Array((await store.audio("t1"))!)).toEqual(new Uint8Array([7]));
    await store.remove("t1");
    await store.update(item({ status: "queued", attempts: 2 }));
    expect(await store.list()).toEqual([]);
  });

  it("moves takes saved by the old version into the new layout, audio and all", async () => {
    const factory = new IDBFactory();
    await openV1(factory, [{ ...item({ takeId: "old", status: "failed", attempts: 6 }), audio: bytes(9, 9) }]);
    const { store } = await openTakeStore(factory);
    expect(await store.list()).toEqual([item({ takeId: "old", status: "failed", attempts: 6 })]);
    expect(new Uint8Array((await store.audio("old"))!)).toEqual(new Uint8Array([9, 9]));
  });

  it("opens the database again when the browser drops the connection", async () => {
    // iOS Safari closes IndexedDB connections behind a backgrounded page; takes kept after that
    // used to fail with "Connection to Indexed Database server lost".
    const factory = new IDBFactory();
    const db = await openDb(factory);
    let reopened = 0;
    const store = new IdbTakeStore(db, () => {
      reopened++;
      return openDb(factory);
    });
    await store.put(item(), bytes(1));
    db.close();
    await store.put(item({ takeId: "t2" }), bytes(2));
    expect(reopened).toBe(1);
    expect((await store.list()).map((i) => i.takeId).sort()).toEqual(["t1", "t2"]);
  });

  it("falls back to memory when there is no IndexedDB", async () => {
    const { store, persistent } = await openTakeStore(undefined);
    expect(persistent).toBe(false);
    await store.put(item(), bytes(4));
    await store.update(item({ attempts: 3 }));
    expect(await store.list()).toEqual([item({ attempts: 3 })]);
    expect(new Uint8Array((await store.audio("t1"))!)).toEqual(new Uint8Array([4]));
    await store.remove("t1");
    expect(await store.audio("t1")).toBeNull();
  });

  it("gives up on an open that never answers", async () => {
    const stuck = { open: () => ({}) } as unknown as IDBFactory;
    await expect(openDb(stuck, 10)).rejects.toThrow("didn't open");
    expect((await openTakeStore(stuck)).persistent).toBe(false);
  }, 10_000);
});
