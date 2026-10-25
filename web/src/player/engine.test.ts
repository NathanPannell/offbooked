import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LineAudio, LineAudioApi } from "../api/types";
import { ClipLoader } from "./clips";
import { PlayerEngine } from "./engine";
import type { Part, QueueLine } from "./queue";

// A stand-in for <audio>: records what plays and at what rate; tests end each clip by hand.
class FakeAudio extends EventTarget {
  src = "";
  loop = false;
  currentTime = 0;
  playbackRate = 1;
  defaultPlaybackRate = 1;
  preservesPitch = false;
  ended = false;
  played: { src: string; rate: number }[] = [];
  play() {
    this.ended = false;
    this.played.push({ src: this.src, rate: this.playbackRate });
    this.dispatchEvent(new Event("play"));
    return Promise.resolve();
  }
  pause() {
    this.dispatchEvent(new Event("pause"));
  }
  finish() {
    this.ended = true;
    this.dispatchEvent(new Event("ended"));
  }
  get current() {
    return this.played[this.played.length - 1]!;
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const isSilence = (src: string) => src.startsWith("blob:");

// Scene 1: a, b, c. Scene 2: d, e, f. Every clip is ready unless the test holds it back.
const lines: QueueLine[] = ["a", "b", "c", "d", "e", "f"].map((id, i) => ({ lineId: id, sectionId: i < 3 ? "s1" : "s2", text: "Five words are spoken here." }));

function setup(
  opts: { hold?: (lineId: string, prefetch: boolean) => boolean; source?: (lineId: string) => LineAudio["source"]; segments?: LineAudio["segments"] } = {},
) {
  const calls: { lineId: string; prefetch: boolean }[] = [];
  const held: { lineId: string; resolve: (a: LineAudio) => void }[] = [];
  const answer = (lineId: string): LineAudio => ({
    lineId,
    audioUrl: `clip:${lineId}`,
    durationMs: 2000,
    source: opts.source?.(lineId) ?? "tts",
    ready: true,
    segments: opts.segments,
  });
  const api: LineAudioApi = {
    line: (lineId, o = {}) => {
      calls.push({ lineId, prefetch: Boolean(o.prefetch) });
      if (opts.hold?.(lineId, Boolean(o.prefetch))) return new Promise((resolve) => held.push({ lineId, resolve }));
      return Promise.resolve(answer(lineId));
    },
    warm: () => Promise.resolve({ lines: [] }),
  };
  const audio = new FakeAudio();
  const clips = new ClipLoader(api, () => 1200);
  const engine = new PlayerEngine(audio as unknown as HTMLAudioElement, clips);
  engine.setLines(lines);
  return { audio, clips, engine, calls, held, answer };
}

// Plays until `lineId`'s clip is on, ending each clip and gap on the way. Returns what played.
async function playTo(audio: FakeAudio, lineId: string, max = 40) {
  for (let i = 0; i < max && audio.current.src !== `clip:${lineId}`; i++) {
    audio.finish();
    await flush();
  }
  expect(audio.current.src).toBe(`clip:${lineId}`);
}

beforeEach(() => {
  // Clip downloads are refused, so the player streams the signed URL (here "clip:<id>").
  vi.stubGlobal("fetch", () => Promise.reject(new Error("offline")));
});
afterEach(() => vi.unstubAllGlobals());

describe("playing across a scene change", () => {
  it("runs from the first scene into the second without stopping", async () => {
    const { audio, engine } = setup();
    await flush();
    engine.play();
    await flush();
    expect(audio.current.src).toBe("clip:a");
    await playTo(audio, "d");
    await playTo(audio, "f");
    audio.finish();
    await flush();
    expect(engine.getState().ended).toBe(true);
  });

  it("asks for the line it is waiting on at play priority, even while its prefetch is still out", async () => {
    // The server is slow to answer prefetches of the second scene (the clips are still being
    // made behind other work); the line the listener has reached must not wait in that queue.
    const { audio, engine, calls, held, answer } = setup({ hold: (id, prefetch) => prefetch && id === "d" });
    await flush();
    engine.play();
    await flush();
    await playTo(audio, "c");
    audio.finish(); // the end of scene 1: the scene-change pause
    await flush();
    audio.finish(); // d is due, and only its prefetch is out
    await flush();
    expect(engine.getState().waiting).toBe(false);
    expect(audio.current.src).toBe("clip:d");
    expect(calls.filter((c) => c.lineId === "d")).toEqual([
      { lineId: "d", prefetch: true },
      { lineId: "d", prefetch: false },
    ]);
    held.forEach((h) => h.resolve(answer(h.lineId)));
  });

  it("shows it is waiting while a clip is on its way, then plays it", async () => {
    const { audio, engine, held, answer } = setup({ hold: (id) => id === "b" });
    await flush();
    engine.play();
    await flush();
    audio.finish(); // a ends
    await flush();
    audio.finish(); // the gap ends; b isn't here
    await flush();
    expect(engine.getState().waiting).toBe(true);
    expect(audio.loop).toBe(true);
    held.forEach((h) => h.resolve(answer(h.lineId)));
    await flush();
    await flush();
    expect(engine.getState().waiting).toBe(false);
    expect(audio.current.src).toBe("clip:b");
    expect(audio.loop).toBe(false);
  });
});

describe("my role", () => {
  const mine = (mode: Part["mode"]): Part => ({ mine: new Set(["b", "e"]), mode });

  it("skip: my lines aren't heard, but a silence as long as each one plays in its place", async () => {
    const { audio, engine } = setup();
    engine.setPart(mine("skip"));
    await flush();
    engine.play();
    await flush();
    await playTo(audio, "f");
    const clips = audio.played.map((p) => p.src).filter((s) => s.startsWith("clip:"));
    expect(clips).toEqual(["clip:a", "clip:c", "clip:d", "clip:f"]);
    // a, the gap, then b's silence (longer than a line gap) where b would be.
    const afterA = audio.played.slice(
      audio.played.findIndex((p) => p.src === "clip:a") + 1,
      audio.played.findIndex((p) => p.src === "clip:c"),
    );
    expect(afterA.length).toBeGreaterThanOrEqual(2);
  });

  it("pause, then read: a pause as long as the line takes to say, then the line at normal speed", async () => {
    const { audio, engine } = setup({ source: (id) => (id === "e" ? "actor" : "tts") });
    engine.setPart(mine("pause"));
    engine.setSpeed(2);
    await flush();
    engine.play();
    await flush();
    expect(audio.current).toEqual({ src: "clip:a", rate: 2 });
    audio.finish(); // a
    await flush();
    audio.finish(); // gap
    await flush();
    // b: five spoken words at 2.5 a second; the pause isn't sped up.
    expect(engine.getState().gap?.durationMs).toBe(2000);
    expect(isSilence(audio.current.src)).toBe(true);
    expect(audio.current.rate).toBe(1);
    audio.finish();
    await flush();
    expect(audio.current).toEqual({ src: "clip:b", rate: 1 });
    await playTo(audio, "d");
    expect(audio.current.rate).toBe(2);
    audio.finish(); // d
    await flush();
    audio.finish(); // gap
    await flush();
    // e is recorded (2 s take): 2 s plus 500 ms.
    expect(engine.getState().gap?.durationMs).toBe(2500);
    audio.finish();
    await flush();
    expect(audio.current).toEqual({ src: "clip:e", rate: 1 });
  });

  it("read: my lines play at normal speed while everyone else's are sped up", async () => {
    const { audio, engine } = setup();
    engine.setPart(mine("read"));
    engine.setSpeed(3);
    await flush();
    engine.play();
    await flush();
    await playTo(audio, "f");
    const rates = Object.fromEntries(audio.played.filter((p) => p.src.startsWith("clip:")).map((p) => [p.src.slice(5), p.rate]));
    expect(rates).toEqual({ a: 3, b: 1, c: 3, d: 3, e: 1, f: 3 });
  });

  it("every new clip keeps the chosen speed, from 0.5× to 4×, with the voice's pitch kept", async () => {
    const { audio, engine } = setup();
    engine.setSpeed(0.5);
    await flush();
    engine.play();
    await flush();
    expect(audio.current).toEqual({ src: "clip:a", rate: 0.5 });
    expect(audio.preservesPitch).toBe(true);
    // A change mid-clip applies at once, and to every clip after it; the gaps stay at 1×.
    engine.setSpeed(4);
    expect(audio.playbackRate).toBe(4);
    audio.finish(); // a
    await flush();
    expect(isSilence(audio.current.src)).toBe(true);
    expect(audio.current.rate).toBe(1);
    await playTo(audio, "f");
    const rates = audio.played.filter((p) => p.src.startsWith("clip:")).map((p) => p.rate);
    expect(rates).toEqual([0.5, 4, 4, 4, 4, 4]);
    expect(audio.defaultPlaybackRate).toBe(4);
    // Out of range: clamped to what the player offers.
    engine.setSpeed(10);
    expect(audio.playbackRate).toBe(4);
    engine.setSpeed(0.1);
    expect(audio.playbackRate).toBe(0.5);
  });
});

describe("clip loader", () => {
  it("a prefetch asks once; the line someone waits for asks again before falling back to silence", async () => {
    const calls: boolean[] = [];
    const api: LineAudioApi = {
      line: (lineId, o = {}) => {
        calls.push(Boolean(o.prefetch));
        return Promise.resolve({ lineId, audioUrl: null, durationMs: 1200, source: "tts", ready: false });
      },
      warm: () => Promise.resolve({ lines: [] }),
    };
    const clips = new ClipLoader(api, () => 1500);
    const pre = await clips.load("x", { prefetch: true });
    expect(calls).toEqual([true]);
    expect(pre.url).toBeNull();
    expect(clips.ready("x")).toBeUndefined();
    calls.length = 0;
    const play = await clips.load("x");
    expect(calls).toEqual([false, false, false]);
    expect(play).toMatchObject({ url: null, durationMs: 1500 });
  });
});

describe("position, for word highlighting", () => {
  const segments = [{ startMs: 100, endMs: 1800, text: "Five words are spoken here.", narrator: false }];

  it("reports the clip's media time and its segments while a line plays, then 'after' in the pause", async () => {
    const { audio, engine } = setup({ segments });
    await flush();
    expect(engine.position()).toBeNull();
    engine.play();
    await flush();
    audio.currentTime = 0.75;
    expect(engine.position()).toEqual({ index: 0, kind: "clip", timeMs: 750, durationMs: 2000, segments });
    audio.finish();
    await flush();
    expect(engine.position()).toMatchObject({ index: 0, kind: "after" });
  });

  it("reports the listener's silence on their own line as a gap", async () => {
    const { audio, engine } = setup();
    engine.setPart({ mine: new Set(["b"]), mode: "pause" });
    await flush();
    engine.play();
    await flush();
    audio.finish(); // a ends
    await flush();
    audio.finish(); // the pause before b ends
    await flush();
    audio.currentTime = 0.4;
    const pos = engine.position();
    expect(pos).toMatchObject({ index: 1, kind: "gap", timeMs: 400 });
    expect(pos!.durationMs).toBeGreaterThan(1000);
    expect(pos!.segments).toBeUndefined();
  });
});
