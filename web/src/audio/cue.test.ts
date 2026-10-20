import { describe, expect, it } from "vitest";
import { CUE_SETTLE_MS, playToEnd, type CueElement } from "./cue";

/** An <audio> stand-in: plays when asked (or refuses), and the test makes it pause, end or fail. */
function fakeAudio({ refuse = false } = {}) {
  const log: string[] = [];
  const a = {
    src: "",
    currentTime: 0,
    ended: false,
    paused: true,
    play: () => {
      log.push("play");
      if (refuse) return Promise.reject(new Error("NotAllowedError"));
      a.paused = false;
      return Promise.resolve();
    },
    pause: () => {
      log.push("pause");
      a.paused = true;
      a.onpause?.(new Event("pause"));
    },
    onended: null,
    onerror: null,
    onpause: null,
    ontimeupdate: null,
  } as CueElement & { paused: boolean };
  /** The clip reaches its end: browsers fire pause, then ended. */
  const end = () => {
    a.ended = true;
    a.paused = true;
    a.onpause?.(new Event("pause"));
    a.onended?.(new Event("ended"));
  };
  return { a, log, end };
}

/** Timers run by hand. */
function clock() {
  let now = 0;
  const timers: { at: number; fn: () => void }[] = [];
  return {
    setTimer: ((fn: () => void, ms: number) => {
      const t = { at: now + ms, fn };
      timers.push(t);
      return t;
    }) as unknown as typeof setTimeout,
    clearTimer: ((t: { at: number; fn: () => void }) => {
      const i = timers.indexOf(t);
      if (i >= 0) timers.splice(i, 1);
    }) as unknown as typeof clearTimeout,
    advance: (ms: number) => {
      now += ms;
      for (const t of timers.filter((x) => x.at <= now)) {
        timers.splice(timers.indexOf(t), 1);
        t.fn();
      }
    },
  };
}

const settled = async <T>(p: Promise<T>) => {
  let value: T | "pending" = "pending";
  void p.then((v) => (value = v));
  await Promise.resolve();
  await Promise.resolve();
  return value;
};

describe("playToEnd", () => {
  it("resolves only once the cue has ended, a moment later so the mic doesn't catch its tail", async () => {
    const { a, end } = fakeAudio();
    const c = clock();
    const play = playToEnd(a, "cue.m4a", c);
    expect(a.src).toBe("cue.m4a");
    c.advance(5000);
    a.ontimeupdate?.(new Event("timeupdate"));
    c.advance(5000); // a long cue, still playing: no timer cuts it
    expect(await settled(play.done)).toBe("pending");
    end();
    expect(await settled(play.done)).toBe("pending");
    c.advance(CUE_SETTLE_MS);
    expect(await settled(play.done)).toBe("ended");
    expect(a.onended).toBeNull();
  });

  it("resumes a pause the browser made itself instead of starting the take", async () => {
    const { a, log, end } = fakeAudio();
    const c = clock();
    const play = playToEnd(a, "cue.m4a", c);
    a.paused = true;
    a.onpause?.(new Event("pause")); // an interruption
    expect(log).toEqual(["play", "play"]);
    expect(await settled(play.done)).toBe("pending");
    end();
    c.advance(CUE_SETTLE_MS);
    expect(await settled(play.done)).toBe("ended");
  });

  it("stops at once when asked (a tap on record)", async () => {
    const { a, log } = fakeAudio();
    const play = playToEnd(a, "cue.m4a", clock());
    play.stop();
    expect(await settled(play.done)).toBe("stopped");
    expect(log).toEqual(["play", "pause"]);
    play.stop();
  });

  it("gives up on a cue that can't play or stops moving", async () => {
    const refused = playToEnd(fakeAudio({ refuse: true }).a, "cue.m4a", clock());
    expect(await settled(refused.done)).toBe("failed");
    const { a } = fakeAudio();
    const c = clock();
    const stalled = playToEnd(a, "cue.m4a", c);
    c.advance(7000);
    expect(await settled(stalled.done)).toBe("pending");
    c.advance(1000);
    expect(await settled(stalled.done)).toBe("failed");
    const broken = fakeAudio();
    const failing = playToEnd(broken.a, "cue.m4a", clock());
    broken.a.onerror?.(new Event("error"));
    expect(await settled(failing.done)).toBe("failed");
  });
});
