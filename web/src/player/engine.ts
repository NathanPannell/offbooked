import type { ClipLoader } from "./clips";
import {
  abBounds,
  gapBetweenMs,
  nextIndex,
  prefetchWindow,
  previousIndex,
  stepFor,
  type Ab,
  type QueueLine,
} from "./queue";
import { silenceUrl } from "./silence";

export interface Gap {
  index: number;
  durationMs: number;
  /** performance.now() when the gap ends, or null while paused. */
  endsAt: number | null;
  remainingMs: number;
}

export interface PlayerState {
  /** The current line, as an index into the dialogue lines in order. */
  index: number;
  playing: boolean;
  gap: Gap | null;
  ab: Ab;
  ended: boolean;
  /** The current line's clip is still on its way. */
  waiting: boolean;
}

export interface GapLine {
  index: number;
  lineId: string;
}

export interface GapListener {
  start(line: GapLine, durationMs: number): void;
  /** `completed` is false when the gap was cut short by a seek or a mode change. */
  end(line: GapLine, completed: boolean): void;
}

/** Clips downloaded ahead of the current line, and lines the server is asked to make ahead. */
export const PREFETCH_LINES = 5;
export const WARM_LINES = 25;
const WAIT_LOOP_MS = 250;

type Phase =
  | { kind: "line"; index: number }
  | { kind: "wait"; index: number } // the clip is loading; a short silence loops meanwhile
  | { kind: "speak"; index: number; durationMs: number } // my-part: the actor's own line
  | { kind: "pause"; index: number; next: number }; // the pause between two lines

/**
 * Plays the run-through line by line through one <audio> element: each line's clip, then a short
 * silence, then the next. Pauses, my-part speaking gaps and waits for a clip are silent WAVs on the
 * same element, so playback moves on from `ended` events alone and one tap unlocks it for good.
 */
export class PlayerEngine {
  private lines: QueueLine[] = [];
  private mine: Set<string> | null = null;
  private multiplier = 1.2;
  private phase: Phase | null = null;
  private token = 0;
  private retried = new Set<string>();
  private switchedAt = 0;
  private state: PlayerState = { index: -1, playing: false, gap: null, ab: { a: null, b: null }, ended: false, waiting: false };
  private listeners = new Set<() => void>();
  gapListener: GapListener | null = null;

  constructor(
    private audio: HTMLAudioElement,
    private clips: ClipLoader,
  ) {
    audio.addEventListener("ended", this.onEnded);
    audio.addEventListener("play", this.onPlay);
    audio.addEventListener("pause", this.onPause);
    audio.addEventListener("error", this.onError);
  }

  getState = (): PlayerState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private set(patch: Partial<PlayerState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((l) => l());
  }

  setLines(lines: QueueLine[]) {
    const current = this.lines[this.state.index]?.lineId;
    this.lines = lines;
    const index = current ? lines.findIndex((l) => l.lineId === current) : -1;
    this.set({ index, ab: { a: null, b: null } });
    // Get the opening lines ready before anyone presses play.
    if (lines.length) this.prefetchFrom(Math.max(0, index));
  }

  /** null for full cast; otherwise the line IDs the listener speaks. */
  setMine(mine: Set<string> | null) {
    this.mine = mine;
    const phase = this.phase;
    // Switching to full cast mid-gap: play that line instead.
    if (!mine && phase?.kind === "speak") this.startLine(phase.index, this.state.playing);
  }

  setGapMultiplier(multiplier: number) {
    this.multiplier = multiplier;
  }

  get hasLines(): boolean {
    return this.lines.length > 0;
  }

  /** Call from a tap: starts audio inside the gesture, which unlocks the element on iOS. */
  play() {
    if (!this.hasLines) return;
    if (!this.phase || this.state.ended) {
      const range = abBounds(this.state.ab);
      const from = this.state.ended || this.state.index < 0 ? (range?.first ?? 0) : this.state.index;
      this.startLine(from, true);
      return;
    }
    const token = this.token;
    this.set({ playing: true, ended: false });
    void this.audio.play().catch(() => {
      if (token === this.token) this.set({ playing: false });
    });
  }

  pause() {
    this.set({ playing: false });
    this.audio.pause();
  }


  toggle() {
    if (this.state.playing) this.pause();
    else this.play();
  }

  /** Jumps to a line, and plays from there unless autoplay is false. */
  seekToSegment(index: number, autoplay = true) {
    if (this.lines[index]) this.startLine(index, autoplay);
  }

  next() {
    const index = Math.max(this.state.index, -1) + 1;
    if (index >= this.lines.length) return;
    this.seekToSegment(index, this.state.playing);
  }

  previous() {
    const phase = this.phase;
    const elapsed = phase?.kind === "line" ? this.audio.currentTime * 1000 : phase?.kind === "pause" ? Infinity : 0;
    this.seekToSegment(previousIndex(this.state.index, elapsed), this.state.playing);
  }

  /** Sets A, then B. A third call starts over from a new A. */
  setAbPoint(index: number) {
    const { a, b } = this.state.ab;
    if (a === null || b !== null) {
      this.set({ ab: { a: index, b: null } });
      return;
    }
    this.set({ ab: { a, b: index } });
    this.seekToSegment(Math.min(a, index));
  }

  clearAb() {
    this.set({ ab: { a: null, b: null } });
  }

  private playUrl(url: string, loop = false) {
    const token = this.token;
    this.audio.loop = loop;
    if (this.audio.src !== url) {
      this.switchedAt = performance.now();
      this.audio.src = url;
    } else {
      this.audio.currentTime = 0;
    }
    void this.audio.play().catch((err: unknown) => {
      // A newer src aborts the previous play(); only a refusal (no user gesture yet) stops playback.
      if (token === this.token && !(err instanceof DOMException && err.name === "AbortError")) this.set({ playing: false });
    });
  }

  private cancelGap() {
    const phase = this.phase;
    if (phase?.kind === "speak") {
      this.set({ gap: null });
      this.gapListener?.end(this.gapLine(phase.index), false);
    }
  }

  private gapLine(index: number) {
    return { index, lineId: this.lines[index]?.lineId ?? "" };
  }

  /**
   * Starts a line: its clip, a wait for it, or a speaking gap. Synchronous up to audio.play(), so a
   * tap starts audio inside its gesture. Without autoplay it only moves there; play() starts it.
   */
  private startLine(index: number, autoplay: boolean) {
    this.cancelGap();
    const token = ++this.token;
    const line = this.lines[index];
    if (!line) return;
    this.set({ index, ended: false, gap: null, playing: autoplay, waiting: false });
    this.prefetchFrom(index);
    if (!autoplay) {
      this.phase = null;
      this.audio.pause();
      return;
    }
    const step = stepFor(this.lines, index, this.mine, this.multiplier);
    if (step.kind === "speak") {
      this.phase = step;
      this.set({ gap: { index, durationMs: step.durationMs, endsAt: performance.now() + step.durationMs, remainingMs: step.durationMs } });
      this.gapListener?.start(this.gapLine(index), step.durationMs);
      this.playUrl(silenceUrl(step.durationMs));
      return;
    }
    const clip = this.clips.ready(line.lineId);
    if (clip) {
      this.phase = { kind: "line", index };
      this.playUrl(clip.url ?? silenceUrl(clip.durationMs));
      return;
    }
    this.phase = { kind: "wait", index };
    this.set({ waiting: true });
    this.playUrl(silenceUrl(WAIT_LOOP_MS), true);
    void this.clips.load(line.lineId).then(() => {
      if (token !== this.token || this.phase?.kind !== "wait") return;
      this.startLine(index, this.state.playing);
    });
  }

  private prefetchFrom(index: number) {
    const ab = this.state.ab;
    this.clips.prefetch(prefetchWindow(this.lines, index, PREFETCH_LINES, this.mine, ab));
    this.clips.warm(prefetchWindow(this.lines, index, WARM_LINES, this.mine, ab));
  }

  private onEnded = () => {
    const phase = this.phase;
    if (!phase) return;
    if (phase.kind === "pause") {
      this.startLine(phase.next, true);
      return;
    }
    if (phase.kind === "wait") return;
    if (phase.kind === "speak") {
      this.set({ gap: null });
      this.gapListener?.end(this.gapLine(phase.index), true);
    }
    const next = nextIndex(this.lines, phase.index, this.state.ab);
    if (next === null) {
      this.phase = null;
      this.set({ playing: false, ended: true });
      return;
    }
    this.phase = { kind: "pause", index: phase.index, next };
    this.playUrl(silenceUrl(gapBetweenMs(this.lines, phase.index, next)));
  };

  private onPlay = () => {
    const gap = this.state.gap;
    this.set({
      playing: true,
      ended: false,
      gap: gap ? { ...gap, endsAt: performance.now() + gap.remainingMs } : null,
    });
  };

  private onPause = () => {
    const gap = this.state.gap;
    if (gap && this.phase?.kind === "speak") {
      const remainingMs = Math.max(0, gap.durationMs - this.audio.currentTime * 1000);
      this.set({ gap: { ...gap, endsAt: null, remainingMs } });
    }
    // The end of each clip, and switching src, pause the element without the listener asking.
    // Anything else (the OS, a headset button, another tab's audio) stops playback.
    if (this.audio.ended || performance.now() - this.switchedAt < 150) return;
    this.set({ playing: false });
  };

  // A signed URL that expired, or a clip that won't decode: fetch it again once, else skip it.
  private onError = () => {
    const phase = this.phase;
    if (phase?.kind !== "line") return;
    const lineId = this.lines[phase.index]?.lineId;
    if (!lineId) return;
    this.clips.invalidate(lineId);
    if (this.retried.has(lineId)) {
      this.onEnded();
      return;
    }
    this.retried.add(lineId);
    this.startLine(phase.index, this.state.playing);
  };

  destroy() {
    this.token++;
    this.audio.removeEventListener("ended", this.onEnded);
    this.audio.removeEventListener("play", this.onPlay);
    this.audio.removeEventListener("pause", this.onPause);
    this.audio.removeEventListener("error", this.onError);
    this.audio.pause();
    this.listeners.clear();
  }
}
