import { describe, expect, it, vi } from "vitest";
import type { UploadItem } from "../upload/queue";
import { MemoryTakeStore } from "../upload/store";
import { FileTakeStore, fromBase64, toBase64, type TakeFiles } from "./fileTakeStore";
import { openNativeTakeStore } from "./uploads";

function item(overrides: Partial<UploadItem> = {}): UploadItem {
  return {
    takeId: "t1",
    token: "tok",
    lineId: "l1",
    mime: "audio/mp4",
    durationMs: 1000,
    createdAt: 0,
    status: "queued",
    attempts: 0,
    nextAttemptAt: 0,
    error: null,
    ...overrides,
  };
}

/** A folder in memory, as @capacitor/filesystem would keep it. */
function folder(): TakeFiles & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    readText: async (p) => files.get(p) ?? null,
    writeText: async (p, t) => void files.set(p, t),
    readBase64: async (p) => files.get(p) ?? null,
    writeBase64: async (p, d) => void files.set(p, d),
    list: async () => [...files.keys()],
    remove: async (p) => void files.delete(p),
  };
}

const bytes = (...values: number[]) => new Uint8Array(values).buffer;

describe("the app's take store (files)", () => {
  it("round-trips audio through base64, long takes too", () => {
    const long = new Uint8Array(300_000).map((_, i) => i % 251);
    expect(new Uint8Array(fromBase64(toBase64(long.buffer)))).toEqual(long);
    expect(new Uint8Array(fromBase64(toBase64(new ArrayBuffer(0))))).toEqual(new Uint8Array());
  });

  it("keeps a take and its audio until it's removed, oldest first", async () => {
    const files = folder();
    const store = new FileTakeStore(files);
    await store.put(item({ takeId: "b", createdAt: 2 }), bytes(4));
    await store.put(item({ takeId: "a", createdAt: 1 }), bytes(1, 2, 3));
    expect((await store.list()).map((i) => i.takeId)).toEqual(["a", "b"]);
    expect(new Uint8Array((await store.audio("a"))!)).toEqual(new Uint8Array([1, 2, 3]));
    expect(await store.has("a")).toBe(true);
    await store.remove("a");
    expect(await store.has("a")).toBe(false);
    expect(await store.audio("a")).toBeNull();
    expect([...files.files.keys()].sort()).toEqual(["b.audio", "b.json"]);
  });

  it("changes a take's status without touching its audio, and never brings a removed take back", async () => {
    const store = new FileTakeStore(folder());
    await store.put(item(), bytes(7));
    await store.update(item({ status: "uploading", attempts: 1 }));
    expect(await store.list()).toEqual([item({ status: "uploading", attempts: 1 })]);
    expect(new Uint8Array((await store.audio("t1"))!)).toEqual(new Uint8Array([7]));
    await store.remove("t1");
    await store.update(item({ status: "queued", attempts: 2 }));
    expect(await store.list()).toEqual([]);
  });

  it("skips rows it can't read and keeps take ids inside its folder", async () => {
    const files = folder();
    const store = new FileTakeStore(files);
    files.files.set("broken.json", "{not json");
    files.files.set("other.txt", "x");
    await store.put(item({ takeId: "../../escape" }), bytes(1));
    expect([...files.files.keys()]).toContain("______escape.json");
    expect((await store.list()).map((i) => i.takeId)).toEqual(["../../escape"]);
  });

  it("never brings back a take removed while its status change was on the way", async () => {
    const store = new FileTakeStore(folder());
    await store.put(item(), bytes(7));
    await Promise.all([store.update(item({ status: "failed" })), store.remove("t1")]);
    expect(await store.list()).toEqual([]);
  });

  it("on opening, deletes recordings whose row never got written", async () => {
    const files = folder();
    const store = new FileTakeStore(files);
    await store.put(item({ takeId: "kept" }), bytes(1));
    files.files.set("lost.audio", "AAAA");
    await store.open();
    expect([...files.files.keys()].sort()).toEqual(["kept.audio", "kept.json"]);
  });

  it("falls back to the web view's store when the folder can't be written", async () => {
    const broken = { ...folder(), writeText: () => Promise.reject(new Error("read-only")) };
    const fallback = vi.fn(async () => ({ store: new MemoryTakeStore(), persistent: false }));
    expect((await openNativeTakeStore(broken, fallback)).persistent).toBe(false);
    const ok = await openNativeTakeStore(folder(), fallback);
    expect(ok.persistent).toBe(true);
    expect(ok.store).toBeInstanceOf(FileTakeStore);
    expect(fallback).toHaveBeenCalledOnce();
  });
});
