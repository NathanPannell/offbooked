import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applySpeed,
  clampSpeed,
  formatSpeed,
  getSpeed,
  msUntil,
  nextSpeed,
  parseSpeed,
  resetSpeedForTests,
  setSpeed,
  snapSpeed,
  SPEED_KEY,
  SPEEDS,
  subscribeSpeed,
} from "./speed";

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
  resetSpeedForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetSpeedForTests();
});

describe("playback speeds", () => {
  it("offers 0.5× to 4×, starting at 1×", () => {
    expect(SPEEDS).toEqual([0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4]);
    expect(getSpeed()).toBe(1);
    expect(formatSpeed(1.5)).toBe("1.5×");
  });

  it("a tap steps up through every speed, then round again from the slowest", () => {
    const seen = [1];
    for (let i = 0; i < SPEEDS.length; i++) seen.push(nextSpeed(seen[seen.length - 1]!));
    expect(seen).toEqual([1, 1.25, 1.5, 2, 3, 4, 0.5, 0.75, 1]);
    // A rate between steps goes to the next one up; anything out of range is clamped first.
    expect(nextSpeed(1.1)).toBe(1.25);
    expect(nextSpeed(2.5)).toBe(3);
    expect(nextSpeed(9)).toBe(0.5);
    expect(nextSpeed(0.1)).toBe(0.75);
  });

  it("clamps any rate to 0.5×–4×, and nonsense to 1×", () => {
    expect(clampSpeed(0.25)).toBe(0.5);
    expect(clampSpeed(6)).toBe(4);
    expect(clampSpeed(1.5)).toBe(1.5);
    expect(clampSpeed(NaN)).toBe(1);
    expect(clampSpeed(0)).toBe(1);
    expect(clampSpeed(-2)).toBe(1);
    expect(clampSpeed("2")).toBe(1);
    expect(clampSpeed(Infinity)).toBe(1);
  });

  it("snaps a rate set in code to the nearest step", () => {
    expect(snapSpeed(1.1)).toBe(1);
    expect(snapSpeed(1.2)).toBe(1.25);
    expect(snapSpeed(2.6)).toBe(3);
    expect(snapSpeed(9)).toBe(4);
    expect(snapSpeed(0.1)).toBe(0.5);
    expect(snapSpeed("x")).toBe(1);
  });

  it("times the end of Listen back in media time, at the speed it plays", () => {
    // 3 s of voice, 1 s in: 2 s of media left, 1 s at 2×, 4 s at 0.5×.
    expect(msUntil(3000, 1, 2)).toBe(1000);
    expect(msUntil(3000, 1, 0.5)).toBe(4000);
    expect(msUntil(3000, 1, 1)).toBe(2000);
    expect(msUntil(3000, 4, 4)).toBe(0);
    expect(msUntil(3000, 0, 0)).toBe(3000);
  });

  it("reads back only a speed it offers", () => {
    expect(parseSpeed("1.5")).toBe(1.5);
    expect(parseSpeed("4")).toBe(4);
    expect(parseSpeed("2.5")).toBe(1);
    expect(parseSpeed("fast")).toBe(1);
    expect(parseSpeed(null)).toBe(1);
  });
});

describe("the chosen speed", () => {
  it("is remembered on this device and read back on the next visit", () => {
    const heard: number[] = [];
    const off = subscribeSpeed(() => heard.push(getSpeed()));
    setSpeed(2);
    expect(storage.map.get(SPEED_KEY)).toBe("2");
    setSpeed(2); // no change, no news
    setSpeed(0.5);
    off();
    setSpeed(3);
    expect(heard).toEqual([2, 0.5]);
    resetSpeedForTests();
    expect(getSpeed()).toBe(3);
    setSpeed(1.6); // not a step: the nearest one
    expect(getSpeed()).toBe(1.5);
  });

  it("reads storage again once nothing listens, so another tab's change isn't missed", () => {
    const off = subscribeSpeed(() => {});
    expect(getSpeed()).toBe(1);
    off();
    storage.map.set(SPEED_KEY, "2"); // set in another tab while no player was on screen
    expect(getSpeed()).toBe(2);
  });

  it("a stored speed that isn't offered reads as 1×", () => {
    storage.map.set(SPEED_KEY, "7");
    expect(getSpeed()).toBe(1);
  });

  it("works for this visit when storage throws", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    });
    expect(getSpeed()).toBe(1);
    setSpeed(1.5);
    expect(getSpeed()).toBe(1.5);
  });
});

describe("applySpeed", () => {
  it("sets the rate the next clip keeps, and keeps the voice's pitch", () => {
    const audio = { playbackRate: 1, defaultPlaybackRate: 1, preservesPitch: false, webkitPreservesPitch: false, mozPreservesPitch: false };
    applySpeed(audio as unknown as HTMLMediaElement, 4);
    expect(audio).toEqual({ playbackRate: 4, defaultPlaybackRate: 4, preservesPitch: true, webkitPreservesPitch: true, mozPreservesPitch: true });
    applySpeed(audio as unknown as HTMLMediaElement, 10);
    expect(audio.playbackRate).toBe(4);
    applySpeed(audio as unknown as HTMLMediaElement, 0.5);
    expect(audio.defaultPlaybackRate).toBe(0.5);
  });
});
