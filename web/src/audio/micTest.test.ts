import { describe, expect, it, vi } from "vitest";
import { startVad, vadStep } from "../stt/live";
import { drawLevel, MIC_CHECK_MAX_MS, micCheckDone, recordSample, traceBars, type TestMic } from "./micTest";
import { MicError } from "./recorder";

describe("when the mic check has heard enough", () => {
  /** Feeds 50 ms frames of `db` for `ms`, and says whether the check is done after each. */
  const feed = (steps: [number, number][]) => {
    let vad = startVad();
    let doneAt: number | null = null;
    for (const [db, ms] of steps) {
      for (let t = 0; t < ms; t += 50) {
        vad = vadStep(vad, db, 50);
        if (doneAt === null && micCheckDone(vad)) doneAt = vad.elapsedMs;
      }
    }
    return doneAt;
  };

  it("plays back once someone has spoken and then stopped for a moment", () => {
    // Quiet, "hello there" for a second, then quiet: done 0.7 s after they stop.
    expect(
      feed([
        [-70, 500],
        [-22, 1000],
        [-70, 2000],
      ]),
    ).toBe(2200);
  });

  it("waits through the short gaps between words", () => {
    expect(
      feed([
        [-70, 300],
        [-22, 600],
        [-70, 300],
        [-22, 600],
        [-70, 2000],
      ]),
    ).toBe(2500);
  });

  it("doesn't play back on a cough or a tap", () => {
    expect(
      feed([
        [-70, 500],
        [-10, 100],
        [-70, 2000],
      ]),
    ).toBeNull();
  });

  it("plays back after a few seconds whatever it heard", () => {
    expect(feed([[-70, 8000]])).toBe(MIC_CHECK_MAX_MS);
    expect(feed([[-22, 8000]])).toBe(MIC_CHECK_MAX_MS);
  });
});

describe("drawing the mic check", () => {
  it("scales speech to most of the meter and silence to nothing", () => {
    expect(drawLevel(new Float32Array(64))).toBe(0);
    expect(drawLevel(new Float32Array(64).fill(0.05))).toBeGreaterThan(0.3);
    expect(drawLevel(new Float32Array(64).fill(1))).toBe(1);
  });

  it("fits a clip's levels into the bars the meter has room for, keeping each peak", () => {
    expect(traceBars([0.1, 0.9, 0.2, 0.3, 0.5, 0.4], 3)).toEqual([0.9, 0.3, 0.5]);
    expect(traceBars([0.2, 0.6], 4)).toEqual([0.2, 0.2, 0.6, 0.6]);
    expect(traceBars([], 4)).toEqual([]);
    expect(traceBars([0.5], 0)).toEqual([]);
  });
});

function fakeMic({ openError, blob = new Blob(["abc"], { type: "audio/webm" }) }: { openError?: Error; blob?: Blob } = {}) {
  const log: string[] = [];
  const mic: TestMic = {
    open: async () => {
      log.push("open");
      if (openError) throw openError;
    },
    start: (maxMs) => {
      log.push(`start ${maxMs}`);
      return {
        stop: async () => {
          log.push("stop");
          return { blob, durationMs: 3000 };
        },
        cancel: () => log.push("cancel"),
      };
    },
    close: () => log.push("close"),
  };
  return { mic, log };
}

describe("the mic test", () => {
  it("records the sample, then closes the mic", async () => {
    const { mic, log } = fakeMic();
    const waited: number[] = [];
    const onListening = vi.fn();
    const blob = await recordSample(mic, 3000, { onListening, wait: async (ms) => void waited.push(ms) });
    expect(blob.size).toBe(3);
    expect(waited).toEqual([3000]);
    expect(onListening).toHaveBeenCalledOnce();
    expect(log).toEqual(["open", "start 4000", "stop", "close"]);
  });

  it("closes the mic and explains when it is blocked", async () => {
    const { mic, log } = fakeMic({ openError: new MicError("denied", "Microphone access was blocked.") });
    const error = await recordSample(mic, 3000, { wait: async () => {} }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MicError);
    expect((error as MicError).kind).toBe("denied");
    expect(log).toEqual(["open", "close"]);
  });

  it("turns an unexpected failure or an empty sample into a mic error", async () => {
    const broken = fakeMic({ openError: new Error("boom") });
    expect(((await recordSample(broken.mic, 10, { wait: async () => {} }).catch((e: unknown) => e)) as MicError).kind).toBe("unknown");
    const silent = fakeMic({ blob: new Blob([]) });
    expect(await recordSample(silent.mic, 10, { wait: async () => {} }).catch((e: unknown) => e)).toBeInstanceOf(MicError);
    expect(silent.log.at(-1)).toBe("close");
  });
});
