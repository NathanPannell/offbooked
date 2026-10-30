import { describe, expect, it, vi } from "vitest";
import { ScreenKeeper, type FallbackVideo, type KeeperEnv } from "./wakeLock";

const flush = () => new Promise((r) => setTimeout(r, 0));

// A stand-in for WakeLockSentinel: the test can release it the way the browser does.
class FakeSentinel extends EventTarget {
  released = false;
  release() {
    this.released = true;
    this.dispatchEvent(new Event("release"));
    return Promise.resolve();
  }
}

class FakeDocument extends EventTarget {
  visibilityState: DocumentVisibilityState = "visible";
  show(state: DocumentVisibilityState) {
    this.visibilityState = state;
    this.dispatchEvent(new Event("visibilitychange"));
  }
}

class FakeVideo implements FallbackVideo {
  paused = true;
  plays = 0;
  play() {
    this.paused = false;
    this.plays++;
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
  }
}

function setup({ api = true, refuse = false, refuseWhenHidden = false, preReleased = false } = {}) {
  const sentinels: FakeSentinel[] = [];
  const request = vi.fn((type: "screen") => {
    expect(type).toBe("screen");
    if (refuse) return Promise.reject(new DOMException("Low Power Mode", "NotAllowedError"));
    // The browser settles the request later: a page that hid meanwhile is refused.
    return Promise.resolve().then(() => {
      if (refuseWhenHidden && doc.visibilityState !== "visible") throw new DOMException("hidden", "NotAllowedError");
      const s = new FakeSentinel();
      if (preReleased) s.released = true;
      sentinels.push(s);
      return s;
    });
  });
  const doc = new FakeDocument();
  const video = new FakeVideo();
  const createVideo = vi.fn(() => video);
  const env = {
    wakeLock: api ? { request } : undefined,
    document: doc,
    createVideo,
  } as unknown as KeeperEnv;
  const live = () => sentinels.filter((s) => !s.released);
  return { keeper: new ScreenKeeper(env), request, doc, video, createVideo, sentinels, live };
}

describe("ScreenKeeper", () => {
  it("takes the wake lock when held and releases it when let go", async () => {
    const { keeper, request, live } = setup();
    const release = keeper.hold();
    await flush();
    expect(request).toHaveBeenCalledTimes(1);
    expect(live()).toHaveLength(1);
    release();
    await flush();
    expect(live()).toHaveLength(0);
    expect(keeper.held).toBe(false);
  });

  it("keeps the lock until the last holder lets go, and ignores a second release", async () => {
    const { keeper, request, live } = setup();
    const recording = keeper.hold();
    const playing = keeper.hold();
    await flush();
    expect(request).toHaveBeenCalledTimes(1);
    recording();
    recording();
    await flush();
    expect(live()).toHaveLength(1);
    playing();
    await flush();
    expect(live()).toHaveLength(0);
  });

  it("asks again when the browser drops the lock while it is still held", async () => {
    const { keeper, request, sentinels, live } = setup();
    keeper.hold();
    await flush();
    void sentinels[0]!.release();
    await flush();
    expect(request).toHaveBeenCalledTimes(2);
    expect(live()).toHaveLength(1);
  });

  it("waits for the page to show again before asking, then takes it back", async () => {
    const { keeper, request, sentinels, doc, live } = setup();
    keeper.hold();
    await flush();
    // Switching tabs: the document hides and the browser releases the lock.
    doc.visibilityState = "hidden";
    void sentinels[0]!.release();
    doc.show("hidden");
    await flush();
    expect(request).toHaveBeenCalledTimes(1);
    doc.show("visible");
    await flush();
    expect(request).toHaveBeenCalledTimes(2);
    expect(live()).toHaveLength(1);
  });

  it("doesn't take the lock back after it was let go", async () => {
    const { keeper, request, doc } = setup();
    keeper.hold()();
    await flush();
    doc.show("visible");
    await flush();
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("releases a lock that arrives after it was let go", async () => {
    const { keeper, sentinels } = setup();
    const release = keeper.hold();
    release();
    await flush();
    expect(sentinels[0]!.released).toBe(true);
  });

  it("plays the muted video where the API is missing, and pauses it when let go", async () => {
    const { keeper, video, createVideo } = setup({ api: false });
    const release = keeper.hold();
    expect(video.paused).toBe(false);
    release();
    expect(video.paused).toBe(true);
    keeper.hold();
    expect(createVideo).toHaveBeenCalledTimes(1);
    expect(video.plays).toBe(2);
  });

  it("falls back to the video when the lock is refused, and tries the API again next time", async () => {
    const { keeper, video, request } = setup({ refuse: true });
    const release = keeper.hold();
    await flush();
    expect(video.paused).toBe(false);
    release();
    keeper.hold();
    await flush();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("restarts the video when the page shows again", async () => {
    const { keeper, video, doc } = setup({ api: false });
    keeper.hold();
    // iOS pauses media in a hidden page.
    video.pause();
    doc.show("hidden");
    expect(video.paused).toBe(true);
    doc.show("visible");
    expect(video.paused).toBe(false);
  });

  it("stops the video while the screen is off, so only the run-through's audio plays", async () => {
    const { keeper, video, doc } = setup({ api: false });
    keeper.hold();
    expect(video.paused).toBe(false);
    doc.show("hidden");
    expect(video.paused).toBe(true);
    doc.show("visible");
    expect(video.paused).toBe(false);
  });

  it("doesn't switch to the video for a refusal that lands after it was let go", async () => {
    const { keeper, video, request } = setup({ refuse: true });
    keeper.hold()();
    await flush();
    keeper.hold();
    await flush();
    expect(request).toHaveBeenCalledTimes(2);
    expect(video.plays).toBe(1);
  });

  it("asks the API again when shown after a refusal caused by the page hiding", async () => {
    const { keeper, video, request, doc, live } = setup({ refuseWhenHidden: true });
    keeper.hold();
    doc.visibilityState = "hidden";
    await flush();
    expect(video.plays).toBe(0);
    doc.show("visible");
    await flush();
    expect(request).toHaveBeenCalledTimes(2);
    expect(live()).toHaveLength(1);
    expect(video.plays).toBe(0);
  });

  it("falls back to the video when the lock arrives already released", async () => {
    const { keeper, video } = setup({ preReleased: true });
    keeper.hold();
    await flush();
    expect(video.paused).toBe(false);
  });
});
