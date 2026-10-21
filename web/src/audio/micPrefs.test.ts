import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  chooseMic,
  claimFirstTakeHint,
  FIRST_TAKE_HINT_KEY,
  markMicChecked,
  MIC_CHECKED_KEY,
  MIC_DEVICE_KEY,
  micOptions,
  needsMicCheck,
  rememberedMic,
  rememberMic,
} from "./micPrefs";
import { micConstraints } from "./recorder";

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

const input = (deviceId: string, label = "") => ({ deviceId, kind: "audioinput" as const, label });

describe("mic device memory", () => {
  it("remembers the chosen mic and forgets it when the default is picked", () => {
    expect(rememberedMic()).toBeNull();
    rememberMic("usb-mic");
    expect(storage.map.get(MIC_DEVICE_KEY)).toBe("usb-mic");
    expect(rememberedMic()).toBe("usb-mic");
    rememberMic(null);
    expect(rememberedMic()).toBeNull();
    expect(storage.map.has(MIC_DEVICE_KEY)).toBe(false);
  });

  it("uses the remembered mic only while it is still there", () => {
    const options = micOptions([input("built-in", "MacBook Microphone"), input("usb-mic", "Yeti")]);
    expect(chooseMic(options, "usb-mic")).toBe("usb-mic");
    expect(chooseMic(options, "unplugged")).toBe("");
    expect(chooseMic(options, null)).toBe("");
  });

  it("lists the default first, each input once, and names unlabelled mics", () => {
    const options = micOptions([
      input("default", "Default - Yeti"),
      input("communications", "Communications - Yeti"),
      input("built-in"),
      input("usb-mic", " Yeti "),
      input("usb-mic", "Yeti"),
      { deviceId: "speakers", kind: "audiooutput" as const, label: "Speakers" },
      input(""),
    ]);
    expect(options).toEqual([
      { id: "", label: "Default microphone" },
      { id: "built-in", label: "Microphone 1" },
      { id: "usb-mic", label: "Yeti" },
    ]);
  });

  it("asks for the chosen mic, keeping the voice clean-up", () => {
    expect(micConstraints("usb-mic")).toEqual({ echoCancellation: true, noiseSuppression: true, autoGainControl: true, deviceId: { ideal: "usb-mic" } });
    expect(micConstraints(null)).toEqual({ echoCancellation: true, noiseSuppression: true, autoGainControl: true });
  });

  it("works without storage", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    });
    expect(() => rememberMic("usb-mic")).not.toThrow();
    expect(rememberedMic()).toBeNull();
  });
});

describe("first-run flags", () => {
  it("offers the mic check until it is done or skipped", () => {
    expect(needsMicCheck()).toBe(true);
    markMicChecked();
    expect(storage.map.get(MIC_CHECKED_KEY)).toBe("1");
    expect(needsMicCheck()).toBe(false);
  });

  it("gives the first take's hint once per device", () => {
    expect(claimFirstTakeHint()).toBe(true);
    expect(storage.map.get(FIRST_TAKE_HINT_KEY)).toBe("1");
    expect(claimFirstTakeHint()).toBe(false);
    expect(claimFirstTakeHint()).toBe(false);
  });

  it("keeps the flags apart", () => {
    claimFirstTakeHint();
    expect(needsMicCheck()).toBe(true);
    markMicChecked();
    storage.map.delete(FIRST_TAKE_HINT_KEY);
    expect(claimFirstTakeHint()).toBe(true);
  });
});
