import {
  abLoopTarget,
  abRange,
  gapMs,
  myGapSegmentAt,
  nextLineStart,
  previousLineStart,
  segmentIndexAt,
  type Segment,
} from "./timing";

export interface Gap {
  index: number;
  durationMs: number;
  /** performance.now() when the gap ends, or null while paused. */
  endsAt: number | null;
  remainingMs: number;
}

export interface PlayerState {
  index: number;
  playing: boolean;
  gap: Gap | null;
  ab: { a: number | null; b: number | null };
  ended: boolean;
}

export interface GapListener {
  start(segment: Segment, durationMs: number): void;
  /** `completed` is false when the gap was cut short by a seek or pause. */
  end(segment: Segment, completed: boolean): void;
}

/**
 * Drives one <audio> element from the render's timing map. In my-part mode it pauses
 * over the actor's own segments and holds a speaking gap instead. All client-side.
 */
export class PlayerEngine {
  private segments: Segment[] = [];
  private texts = new Map<string, string>();
  private mine: Set<string> | null = null;
  private multiplier = 1.2;
  private state: PlayerState = { index: -1, playing: false, gap: null, ab: { a: null, b: null }, ended: false };
  private listeners = new Set<() => void>();
  private frame = 0;
  private gapTimer: ReturnType<typeof setTimeout> | null = null;
  gapListener: GapListener | null = null;

  constructor(private audio: HTMLAudioElement) {
    audio.addEventListener("timeupdate", this.tick);
    audio.addEventListener("ended", this.onEnded);
    audio.addEventListener("play", this.onPlay);
    audio.addEventListener("pause", this.onPause);
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

  setTimeline(segments: Segment[], texts: Map<string, string>) {
    this.segments = segments;
    this.texts = texts;
    this.set({ index: segmentIndexAt(segments, this.timeMs()), ab: { a: null, b: null } });
  }

  /** null for full cast; otherwise the line IDs the listener speaks. */
  setMine(mine: Set<string> | null) {
    this.mine = mine;
    if (!mine && this.state.gap) this.finishGap(false, true);
  }

  setGapMultiplier(multiplier: number) {
    this.multiplier = multiplier;
  }

  timeMs(): number {
    return this.audio.currentTime * 1000;
  }

  get hasAudio(): boolean {
    return !!this.audio.currentSrc;
  }

  play() {
    if (!this.hasAudio) return;
    const gap = this.state.gap;
    if (gap) {
      this.resumeGap(gap);
      return;
    }
    if (this.state.ended) this.audio.currentTime = 0;
    this.set({ ended: false, playing: true });
    void this.audio.play().catch(() => this.set({ playing: false }));
  }

  pause() {
    const gap = this.state.gap;
    if (gap && gap.endsAt !== null) {
      if (this.gapTimer) clearTimeout(this.gapTimer);
      this.set({ playing: false, gap: { ...gap, endsAt: null, remainingMs: Math.max(0, gap.endsAt - performance.now()) } });
      return;
    }
    this.audio.pause();
  }

  toggle() {
    if (this.state.playing) this.pause();
    else this.play();
  }

  /** Jumps to a line and plays from there. */
  seekToSegment(index: number, autoplay = true) {
    const segment = this.segments[index];
    if (!segment) return;
    this.seekMs(segment.startMs);
    if (autoplay) {
      if (this.mine?.has(segment.lineId)) {
        this.startGap(segment);
      } else {
        this.play();
      }
    }
  }

  next() {
    const from = this.state.gap ? this.segments[this.state.gap.index].startMs : this.timeMs();
    const target = nextLineStart(this.segments, from);
    if (target === null) return;
    this.seekToSegment(segmentIndexAt(this.segments, target), this.state.playing);
  }

  previous() {
    const from = this.state.gap ? this.segments[this.state.gap.index].startMs + 1 : this.timeMs();
    const target = this.state.gap ? previousLineStart(this.segments, from, Infinity) : previousLineStart(this.segments, from);
    this.seekToSegment(segmentIndexAt(this.segments, target), this.state.playing);
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

  private seekMs(ms: number) {
    if (this.state.gap) this.finishGap(false, false);
    this.audio.currentTime = ms / 1000;
    this.set({ index: segmentIndexAt(this.segments, ms), ended: false });
  }

  private startGap(segment: Segment) {
    if (this.gapTimer) clearTimeout(this.gapTimer);
    this.audio.pause();
    const durationMs = gapMs(this.texts.get(segment.lineId) ?? "", this.multiplier);
    const gap: Gap = { index: segment.index, durationMs, endsAt: null, remainingMs: durationMs };
    this.set({ index: segment.index, gap });
    this.gapListener?.start(segment, durationMs);
    this.resumeGap(gap);
  }

  private resumeGap(gap: Gap) {
    const endsAt = performance.now() + gap.remainingMs;
    this.set({ playing: true, gap: { ...gap, endsAt } });
    this.gapTimer = setTimeout(() => this.finishGap(true, true), gap.remainingMs);
    this.loop();
  }

  private finishGap(completed: boolean, resume: boolean) {
    const gap = this.state.gap;
    if (!gap) return;
    if (this.gapTimer) clearTimeout(this.gapTimer);
    this.gapTimer = null;
    const segment = this.segments[gap.index];
    this.set({ gap: null });
    if (segment) this.gapListener?.end(segment, completed);
    if (!resume || !segment) return;
    this.audio.currentTime = segment.endMs / 1000;
    if (this.loopAb(segment.endMs)) return;
    this.set({ playing: true });
    void this.audio.play().catch(() => this.set({ playing: false }));
  }

  private loopAb(ms: number): boolean {
    const { a, b } = this.state.ab;
    if (a === null || b === null) return false;
    const target = abLoopTarget(abRange(this.segments, a, b), ms);
    if (target === null) return false;
    this.seekToSegment(segmentIndexAt(this.segments, target));
    return true;
  }

  private tick = () => {
    if (this.state.gap || this.audio.paused) return;
    const ms = this.timeMs();
    if (this.mine) {
      const mine = myGapSegmentAt(this.segments, this.mine, ms);
      if (mine) {
        this.startGap(mine);
        return;
      }
    }
    if (this.loopAb(ms)) return;
    const index = segmentIndexAt(this.segments, ms);
    if (index !== this.state.index) this.set({ index });
  };

  private loop = () => {
    cancelAnimationFrame(this.frame);
    const step = () => {
      this.tick();
      if (this.state.playing) this.frame = requestAnimationFrame(step);
    };
    this.frame = requestAnimationFrame(step);
  };

  private onPlay = () => {
    this.set({ playing: true, ended: false });
    this.loop();
  };

  private onPause = () => {
    if (!this.state.gap) this.set({ playing: false });
  };

  private onEnded = () => {
    this.set({ playing: false, ended: true });
  };

  destroy() {
    cancelAnimationFrame(this.frame);
    if (this.gapTimer) clearTimeout(this.gapTimer);
    this.audio.removeEventListener("timeupdate", this.tick);
    this.audio.removeEventListener("ended", this.onEnded);
    this.audio.removeEventListener("play", this.onPlay);
    this.audio.removeEventListener("pause", this.onPause);
    this.audio.pause();
    this.listeners.clear();
  }
}
