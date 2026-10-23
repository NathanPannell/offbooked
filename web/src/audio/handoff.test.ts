import { afterEach, describe, expect, it, vi } from "vitest";
import { LiveCapture } from "./liveCapture";
import { MicSession, START_WAIT_MS, type ActiveTake } from "./recorder";
import { overlapTakes } from "./useTakeRecorder";

// Hands-free recording hands the mic from one take straight to the next: the next take starts
// first, the finished one stops once the next is really recording, and the live capture tells the
// old take's last samples from the new take's first.

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("overlapTakes", () => {
  it("stops the finished take only once the next one is recording", async () => {
    const log: string[] = [];
    let begin: () => void = () => {};
    const next: ActiveTake = { started: new Promise<void>((r) => (begin = r)), stop: async () => ({ blob: new Blob(), durationMs: 0 }), cancel: () => {} };
    const current: ActiveTake = {
      started: Promise.resolve(),
      stop: async () => {
        log.push("stop");
        return { blob: new Blob(["x"]), durationMs: 2000 };
      },
      cancel: () => {},
    };
    const done = overlapTakes(current, next);
    await Promise.resolve();
    expect(log).toEqual([]);
    begin();
    expect((await done).durationMs).toBe(2000);
    expect(log).toEqual(["stop"]);
  });
});

class FakeRecorder {
  static made: FakeRecorder[] = [];
  state: "inactive" | "recording" = "inactive";
  mimeType = "audio/webm";
  onstart: (() => void) | null = null;
  onstop: (() => void) | null = null;
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() {
    FakeRecorder.made.push(this);
  }
  start() {
    this.state = "recording";
  }
  stop() {
    this.state = "inactive";
    this.ondataavailable?.({ data: new Blob(["audio"]) });
    this.onstop?.();
  }
}

function openSession(): MicSession {
  vi.stubGlobal("MediaRecorder", FakeRecorder);
  const session = new MicSession();
  (session as unknown as { stream: object }).stream = { getAudioTracks: () => [{ readyState: "live" }] };
  return session;
}

describe("MicSession takes", () => {
  it("say they've started on the recorder's start event", async () => {
    FakeRecorder.made = [];
    const take = openSession().start(60_000, () => {});
    let started = false;
    void take.started.then(() => (started = true));
    await Promise.resolve();
    expect(started).toBe(false);
    FakeRecorder.made[0]!.onstart?.();
    await take.started;
    expect(started).toBe(true);
  });

  it("count as started after a moment on a browser that never says", async () => {
    vi.useFakeTimers();
    FakeRecorder.made = [];
    const take = openSession().start(60_000, () => {});
    let started = false;
    void take.started.then(() => (started = true));
    await vi.advanceTimersByTimeAsync(START_WAIT_MS - 1);
    expect(started).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(started).toBe(true);
  });

  it("can overlap on one open mic: the next records while the last is still stopping", async () => {
    FakeRecorder.made = [];
    const session = openSession();
    const first = session.start(60_000, () => {});
    const second = session.start(60_000, () => {});
    expect(FakeRecorder.made.map((r) => r.state)).toEqual(["recording", "recording"]);
    const done = overlapTakes(first, second);
    FakeRecorder.made[1]!.onstart?.();
    expect((await done).blob.size).toBeGreaterThan(0);
    expect(FakeRecorder.made.map((r) => r.state)).toEqual(["inactive", "recording"]);
  });
});

/** A capture on a fake worklet: `post` delivers a block from the audio thread, `sent` is what the page told it. */
async function fakeCapture() {
  const sent: unknown[] = [];
  let port: { onmessage: ((e: { data: unknown }) => void) | null; postMessage: (m: unknown) => void } | null = null;
  vi.stubGlobal(
    "AudioWorkletNode",
    class {
      port = { onmessage: null, postMessage: (m: unknown) => sent.push(m) };
      constructor() {
        port = this.port;
      }
      connect() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("URL", { createObjectURL: () => "blob:x", revokeObjectURL: () => {} });
  const node = { connect: () => {}, gain: { value: 1 } };
  const context = { audioWorklet: { addModule: async () => {} }, createGain: () => node, destination: {} } as unknown as AudioContext;
  const capture = (await LiveCapture.attach(context, node as unknown as AudioNode))!;
  const post = (gen: number, values: number[]) => port!.onmessage!({ data: { gen, samples: new Float32Array(values) } });
  return { capture, post, sent };
}

describe("LiveCapture takes", () => {
  it("keep the last take's flushed block out of the next take", async () => {
    const { capture, post, sent } = await fakeCapture();
    const first = capture.begin();
    post(first, [0.1, 0.2]);
    capture.end(first);
    const second = capture.begin();
    // The worklet flushes the first take's last block after the page has begun the second.
    post(first, [0.3]);
    post(second, [0.5, 0.6]);
    expect(capture.length).toBe(2);
    expect([...capture.slice()]).toEqual([0.5, 0.6].map((v) => Math.fround(v)));
    expect(sent).toEqual([
      { cmd: "on", gen: first },
      { cmd: "off", gen: first },
      { cmd: "on", gen: second },
    ]);
  });

  it("don't stop the next take when the last one ends after it began", async () => {
    const { capture, sent } = await fakeCapture();
    const first = capture.begin();
    const second = capture.begin();
    capture.end(first);
    expect(sent.at(-1)).toEqual({ cmd: "off", gen: first });
    expect(second).not.toBe(first);
  });
});
