import { describe, expect, it, vi } from "vitest";
import { recordSample, type TestMic } from "./micTest";
import { MicError } from "./recorder";

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
