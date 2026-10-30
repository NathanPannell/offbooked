import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LineAudio, LineAudioApi, TrackItem } from "../api/types";
import { SPEEDS } from "../audio/speed";
import { ClipLoader } from "./clips";
import { planCues } from "./cuePlan";
import { BACK_AGAIN_MS, PlayerEngine, TRACK_URL_FRESH_MS } from "./engine";
import { pollTrack, stretchToAsk, trackWindow } from "./listenTrack";
import { NO_PART, type Part, type QueueLine } from "./queue";
import { skipSoundUrl } from "./silence";
import { SKIP_PAUSE_MS } from "./skipSound";

// A stand-in for <audio>: records what plays and at what rate; tests end each clip by hand.
class FakeAudio extends EventTarget {
  src = "";
  loop = false;
  currentTime = 0;
  playbackRate = 1;
  defaultPlaybackRate = 1;
  preservesPitch = false;
  ended = false;
  /** Set to refuse play(), as a locked phone may for a new source. */
  refuse = false;
  played: { src: string; rate: number }[] = [];
  play() {
    if (this.refuse) return Promise.reject(new DOMException("not now", "NotAllowedError"));
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
  opts: {
    hold?: (lineId: string, prefetch: boolean) => boolean;
    source?: (lineId: string) => LineAudio["source"];
    segments?: LineAudio["segments"];
    hidden?: () => boolean;
  } = {},
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
  const engine = new PlayerEngine(audio as unknown as HTMLAudioElement, clips, opts.hidden ?? (() => false));
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

  it.each(SPEEDS)("at %s× (every speed the picker offers), other people's lines play at it and mine at 1×", async (speed) => {
    const { audio, engine } = setup();
    engine.setPart(mine("read"));
    engine.setSpeed(speed);
    await flush();
    engine.play();
    await flush();
    await playTo(audio, "f");
    const clips = audio.played.filter((p) => p.src.startsWith("clip:"));
    expect(Object.fromEntries(clips.map((p) => [p.src.slice(5), p.rate]))).toEqual({ a: speed, b: 1, c: speed, d: speed, e: 1, f: speed });
    // The gaps between lines stay at 1×, and the voices keep their pitch.
    expect(audio.played.filter((p) => isSilence(p.src)).every((p) => p.rate === 1)).toBe(true);
    expect(audio.preservesPitch).toBe(true);
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

describe("listen tracks: one file, so it plays on with the phone locked", () => {
  // The six lines as one track: 2 s each, 350 ms between lines of a scene, 1200 ms at the change.
  // Lines in `speak` get a 2 s pause first (and, with `pauseThenRead`, their audio after it).
  function trackOf(ids: string[], opts: { url?: string; speak?: string[]; pauseThenRead?: boolean } = {}) {
    const items: TrackItem[] = [];
    let t = 0;
    ids.forEach((id, i) => {
      const line = lines.find((l) => l.lineId === id)!;
      const before = lines.find((l) => l.lineId === ids[i - 1]);
      if (before) t += before.sectionId === line.sectionId ? 350 : 1200;
      if (opts.speak?.includes(id)) {
        items.push({ lineId: id, kind: "speak", startMs: t, durationMs: 2000 });
        t += 2000;
        if (!opts.pauseThenRead) return;
      }
      items.push({ lineId: id, kind: "line", startMs: t, durationMs: 2000, source: "tts" });
      t += 2000;
    });
    return { url: opts.url ?? "track:1", items };
  }
  const startOf = (track: { items: TrackItem[] }, id: string, kind: TrackItem["kind"] = "line") =>
    track.items.find((i) => i.lineId === id && i.kind === kind)!.startMs / 1000;
  const tick = (audio: FakeAudio, seconds: number) => {
    audio.currentTime = seconds;
    audio.dispatchEvent(new Event("timeupdate"));
  };

  it("moves onto the track at the next line, then follows its time and only seeks", async () => {
    const { audio, engine } = setup();
    await flush();
    engine.play();
    await flush();
    expect(audio.current.src).toBe("clip:a");
    const track = trackOf(["a", "b", "c", "d", "e", "f"]);
    engine.addTrack(track);
    // a is already playing line by line: it finishes, then b starts from the track.
    expect(engine.getState().onTrack).toBe(false);
    audio.finish(); // a
    await flush();
    // Onto the track at once, in the pause before b (the track holds it): one new source.
    expect(audio.current.src).toBe("track:1");
    expect(audio.currentTime).toBeCloseTo(startOf(track, "b") - 0.35);
    expect(engine.getState()).toMatchObject({ index: 0, onTrack: true, playing: true });
    tick(audio, startOf(track, "b"));
    expect(engine.getState()).toMatchObject({ index: 1, onTrack: true, playing: true });

    // The current line follows the track's time.
    tick(audio, startOf(track, "d") + 0.5);
    expect(engine.getState().index).toBe(3);
    // Skipping and going back are seeks in the same file.
    engine.next();
    expect(audio.currentTime).toBe(startOf(track, "e"));
    expect(engine.getState().index).toBe(4);
    tick(audio, startOf(track, "e") + 0.4);
    engine.previous(); // 400 ms in: back to d
    expect(audio.currentTime).toBe(startOf(track, "d"));
    tick(audio, startOf(track, "d") + 1.8);
    engine.previous(); // well into d: d again
    expect(audio.currentTime).toBe(startOf(track, "d"));
    engine.seekToSegment(0);
    expect(audio.currentTime).toBe(0);
    const sources = audio.played.slice(audio.played.findIndex((p) => p.src === "track:1")).map((p) => p.src);
    expect(new Set(sources)).toEqual(new Set(["track:1"]));
  });

  it("starts from the track straight away when it is ready before play", async () => {
    const { audio, engine } = setup();
    engine.addTrack(trackOf(["a", "b", "c", "d", "e", "f"]));
    await flush();
    engine.play();
    expect(audio.current.src).toBe("track:1");
    expect(audio.currentTime).toBe(0);
    expect(engine.getState().onTrack).toBe(true);
  });

  it("with the track built ahead and asked for when the player opens, the first play is on it and waits for no line", async () => {
    const { audio, engine, calls } = setup();
    const track = trackOf(["a", "b", "c", "d", "e", "f"]);
    // What useListenTrack does on open, before play: the opening stretch, ready at the first ask.
    const start = stretchToAsk(null, lines, NO_PART, 0, engine.trackReach(0));
    expect(start).toBe(0);
    const req = trackWindow(lines, start!, NO_PART);
    const ask = vi.fn(() => Promise.resolve({ track: { status: "ready" as const, durationMs: 14_000, ...track } }));
    pollTrack({ cancelled: false }, ask, req, { ready: (t) => engine.addTrack(t), failed: () => {} });
    await flush();
    expect(ask).toHaveBeenCalledOnce();
    expect(ask).toHaveBeenCalledWith({ lineIds: ["a", "b", "c", "d", "e", "f"], mine: [], mode: "read" });
    const fetchedOnOpen = calls.length;
    engine.play();
    expect(audio.current.src).toBe("track:1");
    expect(engine.getState()).toMatchObject({ index: 0, onTrack: true, playing: true });
    audio.currentTime = startOf(track, "c");
    audio.dispatchEvent(new Event("timeupdate"));
    expect(engine.getState().index).toBe(2);
    // Only the opening lines fetched ahead on open, in case the track wasn't ready; nothing since.
    expect(calls.filter((c) => !c.prefetch)).toEqual([]);
    expect(calls.length).toBe(fetchedOnOpen);
    expect(new Set(audio.played.map((p) => p.src))).toEqual(new Set(["track:1"]));
  });

  it("doesn't start a track whose URL is too old, and takes the fresh one when it comes back", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const { audio, engine } = setup();
      engine.addTrack(trackOf(["a", "b", "c", "d", "e", "f"], { url: "track:1?sig=old" }));
      await flush();
      // The player sat open for longer than the link lasts.
      vi.setSystemTime(Date.now() + TRACK_URL_FRESH_MS + 1000);
      expect(engine.trackReach(0)).toBeNull();
      engine.play();
      await flush();
      expect(audio.current.src).toBe("clip:a");
      // Asked again on play: the same file, a fresh link, entered at the next line.
      engine.addTrack(trackOf(["a", "b", "c", "d", "e", "f"], { url: "track:1?sig=new" }));
      expect(engine.trackReach(0)).toBe(5);
      audio.finish();
      await flush();
      expect(audio.current.src).toBe("track:1?sig=new");
      expect(engine.getState().onTrack).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports the line's time inside the track for highlighting, and 'after' in the pause", async () => {
    const segments = [{ startMs: 100, endMs: 1800, text: "Five words are spoken here.", narrator: false }];
    const { audio, engine } = setup();
    const track = trackOf(["a", "b", "c"]);
    track.items[1]!.segments = segments;
    engine.addTrack(track);
    await flush();
    engine.play();
    tick(audio, startOf(track, "b") + 0.75);
    expect(engine.position()).toEqual({ index: 1, kind: "clip", timeMs: 750, durationMs: 2000, segments, wordStartsMs: undefined, speech: undefined });
    tick(audio, startOf(track, "b") + 2.1);
    expect(engine.position()).toMatchObject({ index: 1, kind: "after" });
  });

  it("other people's lines at the chosen speed; the pauses, my pause and my line at 1×", async () => {
    const { audio, engine } = setup();
    engine.setPart({ mine: new Set(["c"]), mode: "pause" });
    engine.setSpeed(2);
    const track = trackOf(["a", "b", "c", "d"], { speak: ["c"], pauseThenRead: true });
    engine.addTrack(track);
    await flush();
    engine.play();
    tick(audio, 0.5);
    expect(audio.playbackRate).toBe(2);
    tick(audio, 2.1); // between a and b
    expect(audio.playbackRate).toBe(1);
    tick(audio, startOf(track, "c", "speak") + 0.5);
    expect(audio.playbackRate).toBe(1);
    expect(engine.getState().gap).toMatchObject({ index: 2, durationMs: 2000, remainingMs: 1500 });
    expect(engine.position()).toMatchObject({ index: 2, kind: "gap", timeMs: 500 });
    tick(audio, startOf(track, "c") + 0.5);
    expect(engine.getState().gap).toBeNull();
    expect(audio.playbackRate).toBe(1);
    tick(audio, startOf(track, "d") + 0.5);
    expect(audio.playbackRate).toBe(2);
    engine.setSpeed(3);
    expect(audio.playbackRate).toBe(3);
  });

  it("changes speed at each item boundary even with no timeupdate or frame (a locked phone)", async () => {
    const { audio, engine } = setup();
    engine.setPart({ mine: new Set(["b"]), mode: "pause" });
    engine.setSpeed(4);
    const track = trackOf(["a", "b", "c"], { speak: ["b"], pauseThenRead: true });
    engine.addTrack(track);
    await flush();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      engine.play();
      tick(audio, 0.5);
      expect(audio.playbackRate).toBe(4);
      // The rest of a lasts 1.5 s of media, 375 ms at 4×: then the pause after it plays at 1×.
      audio.currentTime = 2.0;
      vi.advanceTimersByTime(376);
      expect(audio.playbackRate).toBe(1);
      // Into my speaking pause, and out of it into c, with no timeupdate on the way.
      audio.currentTime = startOf(track, "b", "speak");
      vi.advanceTimersByTime(351);
      expect(engine.getState().gap).toMatchObject({ index: 1 });
      expect(audio.playbackRate).toBe(1);
      audio.currentTime = startOf(track, "c");
      vi.advanceTimersByTime(startOf(track, "c") * 1000);
      expect(engine.getState().index).toBe(2);
      expect(audio.playbackRate).toBe(4);
      // Paused: nothing is left waiting.
      engine.pause();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(SPEEDS)("at %s× on a track, other people's lines play at it; my pause and my line at 1×", async (speed) => {
    const { audio, engine } = setup();
    engine.setPart({ mine: new Set(["c"]), mode: "pause" });
    engine.setSpeed(speed);
    const track = trackOf(["a", "b", "c", "d"], { speak: ["c"], pauseThenRead: true });
    engine.addTrack(track);
    await flush();
    engine.play();
    const rateIn = (id: string, kind: TrackItem["kind"] = "line") => {
      tick(audio, startOf(track, id, kind) + 0.5);
      return audio.playbackRate;
    };
    expect([rateIn("a"), rateIn("b"), rateIn("c", "speak"), rateIn("c"), rateIn("d")]).toEqual([speed, speed, 1, 1, speed]);
  });

  it("a change of part drops the track and carries on line by line from the current line", async () => {
    const { audio, engine } = setup();
    const track = trackOf(["a", "b", "c", "d", "e", "f"]);
    engine.addTrack(track);
    await flush();
    engine.play();
    tick(audio, startOf(track, "c") + 0.5);
    engine.setPart({ mine: new Set(["d"]), mode: "skip" });
    await flush();
    expect(engine.getState().onTrack).toBe(false);
    expect(audio.current.src).toBe("clip:c");
    expect(engine.trackReach(3)).toBeNull();
    // The same part again keeps a track built for it.
    engine.addTrack(trackOf(["c", "d", "e"], { url: "track:2", speak: ["d"] }));
    engine.setPart({ mine: new Set(["d"]), mode: "skip" });
    expect(engine.trackReach(3)).toBe(4);
  });

  it("a script reloaded unchanged keeps its track; a changed one drops it", async () => {
    const { audio, engine } = setup();
    const track = trackOf(["a", "b", "c", "d", "e", "f"]);
    engine.addTrack(track);
    await flush();
    engine.play();
    tick(audio, startOf(track, "b") + 0.5);
    engine.setLines(lines.map((l) => ({ ...l })));
    expect(engine.getState()).toMatchObject({ index: 1, onTrack: true });
    expect(audio.current.src).toBe("track:1");
    engine.setLines(lines.slice(0, 5));
    await flush();
    expect(engine.getState().onTrack).toBe(false);
    expect(audio.current.src).toBe("clip:b");
  });

  it("a track that won't play falls back to line by line and is never tried again", async () => {
    const { audio, engine } = setup();
    const track = trackOf(["a", "b", "c", "d", "e", "f"], { url: "track:1?sig=one" });
    engine.addTrack(track);
    await flush();
    engine.play();
    tick(audio, startOf(track, "b") + 0.5);
    audio.dispatchEvent(new Event("error"));
    await flush();
    expect(engine.getState().onTrack).toBe(false);
    expect(audio.current.src).toBe("clip:b");
    // Asked for again (a fresh signature on the same file): still line by line.
    engine.addTrack({ ...track, url: "track:1?sig=two" });
    expect(engine.trackReach(2)).toBeNull();
  });

  it("at the end of a track the next line plays from a newer one, or line by line", async () => {
    const { audio, engine } = setup();
    const first = trackOf(["a", "b"]);
    engine.addTrack(first);
    await flush();
    engine.play();
    expect(engine.trackReach(0)).toBe(1);
    // The next stretch arrives while the first plays; the first keeps playing until its end.
    engine.addTrack(trackOf(["c", "d"], { url: "track:2" }));
    tick(audio, startOf(first, "b") + 1);
    expect(audio.current.src).toBe("track:1");
    audio.finish(); // the end of track 1
    await flush();
    expect(engine.getState().onTrack).toBe(false);
    audio.finish(); // the pause after b
    await flush();
    expect(audio.current.src).toBe("track:2");
    expect(engine.getState()).toMatchObject({ index: 2, onTrack: true });
    audio.finish(); // the end of track 2: no newer one, so e plays line by line
    await flush();
    audio.finish();
    await flush();
    expect(audio.current.src).toBe("clip:e");
  });
  it("at the end of a track, a newer one that covers its end is entered in the pause: one new source", async () => {
    const { audio, engine } = setup();
    const first = trackOf(["a", "b"]);
    engine.addTrack(first);
    await flush();
    engine.play();
    // Asked for 40 lines before the end of the first, the next stretch starts back inside it.
    const second = trackOf(["a", "b", "c", "d"], { url: "track:2" });
    engine.addTrack(second);
    tick(audio, startOf(first, "b") + 1);
    audio.finish(); // the end of track 1
    await flush();
    expect(audio.current.src).toBe("track:2");
    expect(audio.currentTime).toBeCloseTo(startOf(second, "c") - 0.35);
    expect(engine.getState()).toMatchObject({ index: 1, onTrack: true, playing: true });
    tick(audio, startOf(second, "c") + 0.1);
    expect(engine.getState().index).toBe(2);
    expect(audio.played.map((p) => p.src).filter(isSilence)).toEqual([]);
  });

  it("play after a pause line by line carries on from the same moment in a track that is ready now", async () => {
    const { audio, engine } = setup();
    await flush();
    engine.play();
    await flush();
    expect(audio.current.src).toBe("clip:a");
    audio.currentTime = 0.8;
    engine.pause();
    const track = trackOf(["a", "b", "c"]);
    engine.addTrack(track);
    // The lock screen's play (or a tap): the rest of a, from the track.
    engine.play();
    expect(audio.current.src).toBe("track:1");
    expect(audio.currentTime).toBeCloseTo(startOf(track, "a") + 0.8);
    expect(engine.getState()).toMatchObject({ index: 0, onTrack: true, playing: true });
  });

  it("play in the pause between lines, or in my speaking pause, picks up the track at the same place", async () => {
    const { audio, engine } = setup();
    engine.setPart({ mine: new Set(["b"]), mode: "pause" });
    await flush();
    engine.play();
    await flush();
    audio.finish(); // a
    await flush();
    expect(isSilence(audio.current.src)).toBe(true);
    engine.pause(); // in the pause before b
    const track = trackOf(["a", "b", "c"], { speak: ["b"], pauseThenRead: true });
    engine.addTrack(track);
    engine.play();
    // The pause before b is already under way: on to b (its speaking pause).
    expect(audio.current.src).toBe("track:1");
    expect(audio.currentTime).toBeCloseTo(startOf(track, "b", "speak"));
    expect(engine.getState().gap).toMatchObject({ index: 1 });

    const again = setup();
    again.engine.setPart({ mine: new Set(["b"]), mode: "pause" });
    await flush();
    again.engine.seekToSegment(1);
    expect(again.engine.getState().gap).toMatchObject({ index: 1 });
    again.audio.currentTime = 1.5; // 1.5 s into my speaking pause
    again.engine.pause();
    again.engine.addTrack(track);
    again.engine.play();
    expect(again.audio.current.src).toBe("track:1");
    expect(again.audio.currentTime).toBeCloseTo(startOf(track, "b", "speak") + 1.5);
    expect(again.engine.getState().gap).toMatchObject({ index: 1, remainingMs: 500 });
  });

  it("a track that only starts at the next line can't hold the pause: the pause plays, then the track", async () => {
    const { audio, engine } = setup();
    await flush();
    engine.play();
    await flush();
    engine.addTrack(trackOf(["b", "c"]));
    audio.finish(); // a
    await flush();
    expect(isSilence(audio.current.src)).toBe(true);
    audio.finish(); // the pause
    await flush();
    expect(audio.current.src).toBe("track:1");
    expect(audio.currentTime).toBe(0);
  });
});

describe("with the phone locked", () => {
  // Stands in for performance.now(), so a pause comes long enough after a source change to count.
  const later = () => {
    const now = performance.now();
    vi.spyOn(performance, "now").mockReturnValue(now + 1000);
  };
  afterEach(() => vi.restoreAllMocks());

  it("marks playback interrupted when a hidden page won't start the next source, and play clears it", async () => {
    let hidden = false;
    const { audio, engine } = setup({ hidden: () => hidden });
    await flush();
    engine.play();
    await flush();
    hidden = true;
    audio.refuse = true;
    audio.finish(); // a ends; the pause after it is refused
    await flush();
    expect(engine.getState()).toMatchObject({ playing: false, interrupted: true });
    // The lock screen's play (or a tap, back on the page) carries on.
    audio.refuse = false;
    engine.play();
    await flush();
    expect(engine.getState()).toMatchObject({ playing: true, interrupted: false });
  });

  it("a clip that arrives after a refused play keeps the interruption for when the listener is back", async () => {
    let hidden = false;
    const { audio, engine, held, answer } = setup({ hidden: () => hidden, hold: (id) => id === "b" });
    await flush();
    engine.play();
    await flush();
    audio.finish(); // a
    await flush();
    hidden = true;
    audio.refuse = true;
    audio.finish(); // the pause; b isn't here yet, and the wait for it is refused
    await flush();
    expect(engine.getState()).toMatchObject({ playing: false, interrupted: true, waiting: true });
    held.filter((h) => h.lineId === "b").forEach((h) => h.resolve(answer("b")));
    await flush();
    expect(engine.getState()).toMatchObject({ playing: false, interrupted: true });
  });

  it("a pause before a play has started (AbortError) is the listener's, not an interruption", async () => {
    const { audio, engine } = setup({ hidden: () => true });
    await flush();
    engine.play();
    await flush();
    engine.pause();
    audio.play = () => Promise.reject(new DOMException("aborted by pause", "AbortError"));
    engine.play();
    await flush();
    expect(engine.getState().interrupted).toBe(false);
  });

  it("a refusal on a page that is showing isn't an interruption (no tap yet)", async () => {
    const { audio, engine } = setup({ hidden: () => false });
    await flush();
    audio.refuse = true;
    engine.play();
    await flush();
    expect(engine.getState()).toMatchObject({ playing: false, interrupted: false });
  });

  it("a pause the system makes while hidden is an interruption; one the listener asks for isn't", async () => {
    let hidden = true;
    const { audio, engine } = setup({ hidden: () => hidden });
    await flush();
    engine.play();
    await flush();
    later();
    engine.pause(); // the lock screen's pause button
    expect(engine.getState()).toMatchObject({ playing: false, interrupted: false });
    engine.play();
    later();
    audio.pause(); // a phone call, another app's audio
    expect(engine.getState()).toMatchObject({ playing: false, interrupted: true });
    audio.dispatchEvent(new Event("play")); // the system lets it carry on
    expect(engine.getState()).toMatchObject({ playing: true, interrupted: false });
    hidden = false;
    later();
    audio.pause();
    expect(engine.getState()).toMatchObject({ playing: false, interrupted: false });
  });

  it("plays a whole scene change, my speaking pause and my line with no timer at all: only ended events", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "setInterval", "requestAnimationFrame"] });
    try {
      const settle = async () => {
        for (let i = 0; i < 20; i++) await Promise.resolve();
      };
      const { audio, engine } = setup();
      engine.setPart({ mine: new Set(["c"]), mode: "pause" });
      await settle();
      engine.play();
      await settle();
      const heard: string[] = [];
      for (let i = 0; i < 40 && !engine.getState().ended; i++) {
        if (!isSilence(audio.current.src)) heard.push(audio.current.src);
        audio.finish();
        await settle();
      }
      expect(engine.getState().ended).toBe(true);
      expect(heard).toEqual(["clip:a", "clip:b", "clip:c", "clip:d", "clip:e", "clip:f"]);
      // Nothing was left waiting on a timer, which a locked phone would hold back.
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("with a part: the plan, cue to cue", () => {
  // MARA speaks at either end of twelve lines; j is her second line's cue, and l her last.
  const ids = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l"];
  const script: QueueLine[] = ids.map((id) => ({ lineId: id, sectionId: "s1", text: "Five words are spoken here." }));
  const mine = new Set(["b", "k"]);
  const part: Part = { mine, mode: "read", plan: planCues(script, mine) };

  function cast(opts: { hidden?: () => boolean } = {}) {
    const made = setup({ hidden: opts.hidden });
    made.engine.setLines(script);
    made.engine.setPart(part);
    return made;
  }

  // What the server lays out for that plan: 2 s a line, 350 ms between, the sound where lines are left out.
  function planned(url = "track:one") {
    const items: TrackItem[] = [];
    let t = 0;
    part.plan!.played.forEach((index, i) => {
      if (i) t += part.plan!.jumps.has(part.plan!.played[i - 1]!) ? SKIP_PAUSE_MS : 350;
      items.push({ lineId: script[index]!.lineId, kind: "line", startMs: t, durationMs: 2000, source: "tts" });
      t += 2000;
    });
    return { url, items };
  }
  const at = (track: { items: TrackItem[] }, id: string) => track.items.find((i) => i.lineId === id)!.startMs / 1000;
  const tick = (audio: FakeAudio, seconds: number) => {
    audio.currentTime = seconds;
    audio.dispatchEvent(new Event("timeupdate"));
  };

  it("plays the fast-forward sound and then the cue, line by line, and never stops to ask", async () => {
    const { audio, engine } = cast();
    await flush();
    engine.play();
    await flush();
    expect(audio.current.src).toBe("clip:a");
    await playTo(audio, "b");
    audio.finish();
    await flush();
    expect(audio.current.src).toBe(skipSoundUrl());
    audio.finish();
    await flush();
    expect(audio.current.src).toBe("clip:j");
    expect(engine.getState().playing).toBe(true);
  });

  it("starts at the first line that plays, and ends after their last when the rest is left out", async () => {
    const lateLines = new Set(["g", "h"]);
    const { audio, engine } = setup();
    engine.setLines(script);
    engine.setPart({ mine: lateLines, mode: "read", plan: planCues(script, lateLines) });
    await flush();
    engine.play();
    await flush();
    expect(audio.current.src).toBe("clip:f");
    await playTo(audio, "h");
    audio.finish();
    await flush();
    expect(engine.getState().ended).toBe(true);
    expect(engine.getState().playing).toBe(false);
  });

  it("before play, gets the first lines that play ready, not the opening it will skip", async () => {
    const late = new Set(["g", "h"]);
    const { calls, engine } = setup();
    engine.setLines(script);
    await flush();
    calls.length = 0;
    engine.setPart({ mine: late, mode: "read", plan: planCues(script, late) });
    await flush();
    expect(calls[0]?.lineId).toBe("f");
  });

  it("⏭ goes to the next cue, ⏮ restarts the current one, and a second ⏮ within 3 s the one before", async () => {
    const now = vi.spyOn(performance, "now").mockReturnValue(1000);
    try {
      const { engine } = cast();
      await flush();
      expect(part.plan!.cues).toEqual([0, 9]);
      engine.next();
      expect(engine.getState().index).toBe(0);
      engine.next();
      expect(engine.getState().index).toBe(9);
      engine.seekToSegment(10, false); // into her line
      engine.previous();
      expect(engine.getState().index).toBe(9);
      now.mockReturnValue(1000 + BACK_AGAIN_MS - 1);
      engine.previous();
      expect(engine.getState().index).toBe(0);
      now.mockReturnValue(1000 + 3 * BACK_AGAIN_MS);
      engine.seekToSegment(10, false);
      engine.previous();
      now.mockReturnValue(1000 + 5 * BACK_AGAIN_MS);
      engine.previous();
      expect(engine.getState().index).toBe(9);
      // Past the last cue, ⏭ stays put.
      engine.seekToSegment(10, false);
      engine.next();
      expect(engine.getState().index).toBe(10);
    } finally {
      now.mockRestore();
    }
  });

  it("⏮ before the first cue goes back to the start of what plays, never forward", async () => {
    const now = vi.spyOn(performance, "now").mockReturnValue(1000);
    try {
      const late = new Set(["d", "k"]);
      const { engine } = setup();
      engine.setLines(script);
      engine.setPart({ mine: late, mode: "read", plan: planCues(script, late) });
      await flush();
      expect(engine.getState().index).toBe(-1);
      engine.previous();
      expect(engine.getState().index).toBe(0);
      engine.seekToSegment(1, false);
      now.mockReturnValue(1000 + 2 * BACK_AGAIN_MS);
      engine.previous();
      expect(engine.getState().index).toBe(0);
      // On the first cue, a second ⏮ goes to the start too.
      engine.seekToSegment(2, false);
      now.mockReturnValue(1000 + 4 * BACK_AGAIN_MS);
      engine.previous();
      expect(engine.getState().index).toBe(2);
      engine.previous();
      expect(engine.getState().index).toBe(0);
    } finally {
      now.mockRestore();
    }
  });

  it("just listening, ⏮ and ⏭ still move line by line", async () => {
    const { engine } = setup();
    await flush();
    engine.seekToSegment(1, false);
    engine.next();
    expect(engine.getState().index).toBe(2);
    engine.previous();
    expect(engine.getState().index).toBe(1);
  });

  it("on the track, a whole listen is one source: the first play, the jump, ⏭, ⏮ and a pause are all seeks", async () => {
    const now = vi.spyOn(performance, "now").mockReturnValue(1000);
    try {
      const { audio, engine, calls } = cast({ hidden: () => true });
      await flush();
      calls.length = 0;
      const track = planned();
      engine.addTrack(track);
      engine.play();
      await flush();
      expect(audio.current.src).toBe("track:one");
      expect(audio.currentTime).toBe(at(track, "a"));
      // Straight across the jump: the file holds the sound, so nothing happens but time passing.
      tick(audio, at(track, "b") + 1.9);
      expect(engine.getState().index).toBe(1);
      tick(audio, at(track, "j") + 0.1);
      expect(engine.getState().index).toBe(9);
      // A fluffed line: ⏮ from the headphones, to the cue, then ⏮ twice to the cue before.
      tick(audio, at(track, "k") + 0.5);
      engine.previous();
      expect(audio.currentTime).toBe(at(track, "j"));
      now.mockReturnValue(1000 + BACK_AGAIN_MS + 1);
      engine.previous();
      expect(audio.currentTime).toBe(at(track, "j"));
      engine.previous();
      expect(audio.currentTime).toBe(at(track, "a"));
      engine.next();
      expect(audio.currentTime).toBe(at(track, "j"));
      engine.pause();
      tick(audio, at(track, "j") + 1);
      engine.play();
      expect(audio.currentTime).toBe(at(track, "j") + 1);
      expect(new Set(audio.played.map((p) => p.src))).toEqual(new Set(["track:one"]));
      expect(calls).toEqual([]);
      audio.finish();
      await flush();
      expect(engine.getState().ended).toBe(true);
    } finally {
      now.mockRestore();
    }
  });

  it("moves onto the track across a jump: in the sound, just before the cue", async () => {
    const { audio, engine } = cast();
    await flush();
    engine.play();
    await playTo(audio, "b");
    const track = planned();
    engine.addTrack(track);
    audio.finish();
    await flush();
    expect(audio.current.src).toBe("track:one");
    expect(audio.currentTime).toBeCloseTo(at(track, "j") - SKIP_PAUSE_MS / 1000);
  });

  it("a line tapped in a stretch left out plays on through it to the cue, and the track takes over there", async () => {
    const { audio, engine } = cast();
    await flush();
    const track = planned();
    engine.addTrack(track);
    engine.seekToSegment(7);
    await flush();
    expect(engine.trackReach(7)).toBeNull();
    expect(audio.current.src).toBe("clip:h");
    await playTo(audio, "i");
    audio.finish(); // the line ends
    await flush();
    audio.finish(); // the pause before the cue, line by line: the track has no "i"
    await flush();
    expect(audio.current.src).toBe("track:one");
    expect(audio.currentTime).toBe(at(track, "j"));
  });

  it("picks up where it was: a place restored after a reload plays from there, on the track, with one tap", async () => {
    const { audio, engine } = cast();
    await flush();
    const track = planned();
    engine.addTrack(track);
    engine.seekToSegment(9, false);
    expect(engine.getState()).toMatchObject({ index: 9, playing: false });
    engine.play();
    await flush();
    expect(audio.current.src).toBe("track:one");
    expect(audio.currentTime).toBe(at(track, "j"));
  });

  it("from the end, play starts again at the first line that plays", async () => {
    const { audio, engine } = cast();
    await flush();
    engine.seekToSegment(11);
    await flush();
    audio.finish();
    await flush();
    expect(engine.getState().ended).toBe(true);
    engine.play();
    await flush();
    expect(audio.current.src).toBe("clip:a");
  });

  it("keeps playing when the plan changes under it, without a stop or a prompt", async () => {
    const { audio, engine } = cast();
    await flush();
    engine.play();
    await playTo(audio, "b");
    engine.setPart({ ...part, plan: planCues(script, mine, false) });
    audio.finish();
    await flush();
    audio.finish();
    await flush();
    expect(audio.current.src).toBe("clip:c");
  });
});
