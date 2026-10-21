import { afterEach, describe, expect, it, vi } from "vitest";
import type { TakeUploadResult } from "../api/actor";
import type { UploadItem } from "./queue";
import { savedTakeId } from "./uploader";

type Listener = (item: UploadItem, result: TakeUploadResult) => void;

function fakeUploader() {
  const listeners = new Set<Listener>();
  return {
    listeners,
    onSaved: (l: Listener) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    save: (takeId: string, serverId: string) => listeners.forEach((l) => l({ takeId } as UploadItem, { take: { id: serverId } } as TakeUploadResult)),
  };
}

describe("savedTakeId", () => {
  afterEach(() => vi.useRealTimers());

  it("answers at once for a take that has landed", async () => {
    const up = fakeUploader();
    expect(await savedTakeId(up, new Map([["c1", "s1"]]), "c1")).toBe("s1");
    expect(up.listeners.size).toBe(0);
  });

  it("waits for its own upload, ignoring others", async () => {
    const up = fakeUploader();
    const id = savedTakeId(up, new Map(), "c2");
    up.save("other", "x");
    up.save("c2", "s2");
    expect(await id).toBe("s2");
    expect(up.listeners.size).toBe(0);
  });

  it("gives up after the timeout", async () => {
    vi.useFakeTimers();
    const up = fakeUploader();
    const id = savedTakeId(up, new Map(), "c3", 1000);
    vi.advanceTimersByTime(1000);
    expect(await id).toBeNull();
    expect(up.listeners.size).toBe(0);
  });
});
