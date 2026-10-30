import { useEffect } from "react";
import keepAwakeUrl from "./keep-awake.mp4?no-inline";

/** What the screen keeper needs from the page, so tests can stand in for the browser. */
export interface KeeperEnv {
  wakeLock: WakeLock | undefined;
  document: Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener">;
  /** A muted, inline, looping video for browsers without the Screen Wake Lock API (iOS before 16.4, some webviews). */
  createVideo: () => FallbackVideo;
}

export interface FallbackVideo {
  play(): Promise<void>;
  pause(): void;
  readonly paused: boolean;
}

/**
 * Keeps the screen on while anything holds it: recording a take, or a run-through playing. Uses the
 * Screen Wake Lock API and asks again whenever the browser drops the lock (the tab was hidden, the
 * battery saver took it); where the API is missing or refuses, plays a tiny muted video on a loop,
 * which keeps phones awake the same way a playing video does.
 */
export class ScreenKeeper {
  private holders = 0;
  private sentinel: WakeLockSentinel | null = null;
  private requesting = false;
  private video: FallbackVideo | null = null;
  private usingVideo = false;

  constructor(private env: KeeperEnv) {}

  /** Holds the screen on until the returned function is called (calling it again does nothing). */
  hold(): () => void {
    this.holders++;
    if (this.holders === 1) {
      this.env.document.addEventListener("visibilitychange", this.onVisibility);
      this.acquire();
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.holders--;
      if (this.holders === 0) this.letGo();
    };
  }

  get held(): boolean {
    return this.holders > 0;
  }

  private acquire() {
    if (!this.held || this.env.document.visibilityState !== "visible") return;
    const wakeLock = this.env.wakeLock;
    if (!wakeLock || this.usingVideo) {
      this.playVideo();
      return;
    }
    if (this.sentinel || this.requesting) return;
    this.requesting = true;
    wakeLock.request("screen").then(
      (sentinel) => {
        this.requesting = false;
        if (!this.held) {
          void sentinel.release().catch(() => {});
          return;
        }
        if (sentinel.released) {
          // Already gone before it reached us: don't wait for a release event that has passed.
          this.usingVideo = true;
          this.acquire();
          return;
        }
        this.sentinel = sentinel;
        sentinel.addEventListener("release", () => {
          if (this.sentinel !== sentinel) return;
          this.sentinel = null;
          // Dropped by the browser, not by us: take it back if the page is still showing.
          this.acquire();
        });
      },
      () => {
        // Refused (iOS Low Power Mode, a policy, no user gesture yet): keep awake with the video instead.
        this.requesting = false;
        // Let go meanwhile, or refused because the page hid: the next hold or showing asks again.
        if (!this.held || this.env.document.visibilityState !== "visible") return;
        this.usingVideo = true;
        this.acquire();
      },
    );
  }

  private playVideo() {
    this.video ??= this.env.createVideo();
    if (this.video.paused) void this.video.play().catch(() => {});
  }

  private letGo() {
    this.env.document.removeEventListener("visibilitychange", this.onVisibility);
    const sentinel = this.sentinel;
    this.sentinel = null;
    void sentinel?.release().catch(() => {});
    this.video?.pause();
    // The next hold tries the API again: a refusal (Low Power Mode) may not last.
    this.usingVideo = false;
  }

  private onVisibility = () => {
    if (this.env.document.visibilityState === "visible") this.acquire();
    // With the screen off there is no screen to keep on: stop the video, so the run-through's
    // audio is the only media playing in a locked phone (it starts again when the page shows).
    else this.video?.pause();
  };
}

function createVideo(): FallbackVideo {
  const video = document.createElement("video");
  video.muted = true;
  video.loop = true;
  video.playsInline = true;
  video.setAttribute("muted", "");
  video.setAttribute("playsinline", "");
  video.setAttribute("aria-hidden", "true");
  video.src = keepAwakeUrl;
  // Out of sight but rendered: iOS doesn't count a video with display: none as playing.
  video.style.cssText = "position:fixed;left:0;bottom:0;width:1px;height:1px;opacity:0.01;pointer-events:none;";
  document.body.appendChild(video);
  return video;
}

let keeper: ScreenKeeper | null = null;

/** Keeps the screen on while held. Release with the returned function. No-op outside a browser. */
export function holdWakeLock(): () => void {
  if (typeof document === "undefined") return () => {};
  keeper ??= new ScreenKeeper({ wakeLock: navigator.wakeLock, document, createVideo });
  return keeper.hold();
}

/** Keeps the screen on for as long as `active` is true and the component is mounted. */
export function useWakeLock(active: boolean) {
  useEffect(() => {
    if (!active) return;
    return holdWakeLock();
  }, [active]);
}
