import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AUTO_ADVANCE_KEY, firstTakeHint, KEEP_RECORDING_KEY, storedFlag } from "./RecordOptions";

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
  };
}

let storage: ReturnType<typeof memoryStorage>;

beforeEach(() => {
  storage = memoryStorage();
  vi.stubGlobal("localStorage", storage);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("recording options", () => {
  it("are hands-free on a device that never chose: move on, and record the next line", () => {
    expect(storedFlag(AUTO_ADVANCE_KEY, true)).toBe(true);
    expect(storedFlag(KEEP_RECORDING_KEY, true)).toBe(true);
  });

  it("keep what the device chose", () => {
    storage.setItem(KEEP_RECORDING_KEY, "0");
    storage.setItem(AUTO_ADVANCE_KEY, "1");
    expect(storedFlag(KEEP_RECORDING_KEY, true)).toBe(false);
    expect(storedFlag(AUTO_ADVANCE_KEY, true)).toBe(true);
  });

  it("ignore the old off-by-default keep-recording setting", () => {
    storage.setItem("offbooked.keepRecording", "0");
    expect(KEEP_RECORDING_KEY).not.toBe("offbooked.keepRecording");
    expect(storedFlag(KEEP_RECORDING_KEY, true)).toBe(true);
  });

  it("work without storage", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
    });
    expect(storedFlag(KEEP_RECORDING_KEY, true)).toBe(true);
  });

  it("say on the first take what happens when the line is said", () => {
    expect(firstTakeHint(true)).toBe("Records the next line when you finish. Change this in mic settings.");
    expect(firstTakeHint(false)).toBe("Moves to the next line when you finish. Change this in mic settings.");
  });
});
