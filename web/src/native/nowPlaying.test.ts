import { afterEach, describe, expect, it, vi } from "vitest";
import type { OffbookedNativePlugin } from "./offbooked";
import { applyCommand, nativeNowPlaying, webNowPlaying, type Controls } from "./nowPlaying";

const controls = (): Controls & { calls: string[] } => {
  const calls: string[] = [];
  return {
    calls,
    play: () => calls.push("play"),
    pause: () => calls.push("pause"),
    toggle: () => calls.push("toggle"),
    next: () => calls.push("next"),
    previous: () => calls.push("previous"),
  };
};

afterEach(() => vi.unstubAllGlobals());

describe("lock screen controls", () => {
  it("runs the known commands and ignores the rest", () => {
    const c = controls();
    for (const command of ["play", "pause", "toggle", "next", "previous", "seek"]) applyCommand(c, command);
    expect(c.calls).toEqual(["play", "pause", "toggle", "next", "previous"]);
  });

  it("in the app, shows Now Playing natively, routes its commands and clears it on close", async () => {
    let listener: ((e: { command: string }) => void) | null = null;
    const remove = vi.fn(async () => {});
    const plugin = {
      setNowPlaying: vi.fn(async () => {}),
      clearNowPlaying: vi.fn(async () => {}),
      addListener: vi.fn(async (_event: string, l: (e: { command: string }) => void) => {
        listener = l;
        return { remove };
      }),
    };
    const np = nativeNowPlaying(plugin as unknown as OffbookedNativePlugin);
    const c = controls();
    const close = np.connect(c);
    np.show({ title: "HAMLET: To be", artist: "Hamlet", album: "Act 3", playing: true });
    expect(plugin.setNowPlaying).toHaveBeenCalledWith({ title: "HAMLET: To be", artist: "Hamlet", album: "Act 3", playing: true });
    listener!({ command: "next" });
    listener!({ command: "pause" });
    expect(c.calls).toEqual(["next", "pause"]);
    close();
    close();
    await Promise.resolve();
    await Promise.resolve();
    expect(remove).toHaveBeenCalledOnce();
    expect(plugin.clearNowPlaying).toHaveBeenCalledOnce();
  });

  it("on the website, uses the Media Session API where there is one", () => {
    const handlers = new Map<string, (() => void) | null>();
    const session = {
      metadata: null as unknown,
      playbackState: "none",
      setActionHandler: (action: string, handler: (() => void) | null) => handlers.set(action, handler),
    };
    vi.stubGlobal(
      "MediaMetadata",
      class {
        constructor(public init: object) {}
      },
    );
    const np = webNowPlaying({ mediaSession: session } as unknown as Navigator);
    const c = controls();
    const close = np.connect(c);
    np.show({ title: "T", artist: "A", album: "B", playing: false });
    expect(session.playbackState).toBe("paused");
    expect((session.metadata as { init: object }).init).toEqual({ title: "T", artist: "A", album: "B" });
    handlers.get("nexttrack")!();
    handlers.get("play")!();
    handlers.get("previoustrack")!();
    handlers.get("pause")!();
    handlers.get("stop")!();
    expect(c.calls).toEqual(["next", "play", "previous", "pause", "pause"]);
    // No seek buttons: iOS shows next and previous instead of skipping 15 seconds.
    expect([...handlers.keys()].some((a) => a.startsWith("seek"))).toBe(false);
    np.show({ title: "T", artist: "A", album: "B", playing: true });
    expect(session.playbackState).toBe("playing");
    close();
    expect([...handlers.values()].every((h) => h === null)).toBe(true);
    // Leaving the player clears the lock screen.
    expect(session.metadata).toBeNull();
    expect(session.playbackState).toBe("none");

    const none = webNowPlaying({} as Navigator);
    expect(() => none.show({ title: "T", artist: "A", album: "B", playing: true })).not.toThrow();
    none.connect(c)();
  });

  it("on the website, an action the browser doesn't know doesn't stop the others", () => {
    const handlers = new Map<string, (() => void) | null>();
    const session = {
      metadata: null as unknown,
      playbackState: "none",
      setActionHandler: (action: string, handler: (() => void) | null) => {
        if (action === "stop") throw new TypeError("not supported");
        handlers.set(action, handler);
      },
    };
    const c = controls();
    const close = webNowPlaying({ mediaSession: session } as unknown as Navigator).connect(c);
    expect([...handlers.keys()].sort()).toEqual(["nexttrack", "pause", "play", "previoustrack"]);
    handlers.get("nexttrack")!();
    expect(c.calls).toEqual(["next"]);
    expect(() => close()).not.toThrow();
  });
});
