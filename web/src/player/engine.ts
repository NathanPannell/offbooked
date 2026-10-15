import type { ClipLoader } from "./clips";
import {
  gapBetweenMs,
  isMine,
  nextIndex,
  NO_PART,
  playableFrom,
  prefetchWindow,
  previousIndex,
  stepFor,
  type Part,
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
  /** The current line, as an index into the played lines in order. */
  index: number;
  playing: boolean;
  /** The pause while the listener says their own line ("Pause, then read"). */
  gap: Gap | null;
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
  | { kind: "wait"; index: number; afterSpeak: boolean } // the clip is loading; a short silence loops meanwhile
  | { kind: "speak"; index: number; durationMs: number; then: "read" | "next" } // the listener says their line; then it plays, or the next one does
  | { kind: "pause"; index: number; next: number }; // the pause between two lines

/** Recorded takes time the listener's pause; TTS and silent lines are timed from their words. */
const recorded = (source: string | undefined) => source === "actor" || source === "standin";

/**
 * Plays the run-through line by line through one <audio> element: each line's clip, then a short
 * silence, then the next. Pauses, the listener's speaking pauses and waits for a clip are silent
 * WAVs on the same element, so playback moves on from `ended` events alone and one tap unlocks it
 * for good. Other people's lines play at the chosen speed (pitch kept); the listener's own at 1×.
 */
export class PlayerEngine {
  private lines: QueueLine[] = [];
  private part: Part = NO_PART;
  private speed = 1;
  private phase: Phase | null = null;
  private token = 0;
  private retried = new Set<string>();
  private switchedAt = 0;
  private state: PlayerState = { index: -1, playing: false, gap: null, ended: false, waiting: false };
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
    audio.preservesPitch = true;
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
    this.set({ index });
    // Get the opening lines ready before anyone presses play.
    if (lines.length) this.prefetchFrom(Math.max(0, index));
  }

  /** The listener's lines (null for none) and what happens on them. */
  setPart(part: Part) {
    const before = this.part;
    this.part = part;
    const phase = this.phase;
    if (!phase) return;
    const line = this.lines[phase.index];
    const wasSpeaking = phase.kind === "speak" || (phase.kind === "wait" && phase.afterSpeak);
    const silentNow = part.mode !== "read" && isMine(part, line);
    // Out of a silence that no longer applies: play the line from here.
    if (wasSpeaking && !silentNow) this.startLine(phase.index, this.state.playing);
    // Between "pause" and "skip" mid-silence: only what comes after it changes.
    else if (phase.kind === "speak") this.phase = { ...phase, then: part.mode === "pause" ? "read" : "next" };
    // A line of mine that is playing now should be a silence instead.
    else if (phase.kind === "line" && silentNow && before.mode === "read") this.startLine(phase.index, this.state.playing);
    else if (phase.kind === "line") this.applyRate(isMine(part, line));
    if (this.lines.length) this.prefetchFrom(Math.max(0, this.state.index));
  }

  /** Playback speed for other people's lines (1 to 3). */
  setSpeed(speed: number) {
    this.speed = Math.min(3, Math.max(1, speed));
    const phase = this.phase;
    if (phase?.kind === "line") this.applyRate(isMine(this.part, this.lines[phase.index]));
  }

  get hasLines(): boolean {
    return this.lines.length > 0;
  }

  /** Call from a tap: starts audio inside the gesture, which unlocks the element on iOS. */
  play() {
    if (!this.hasLines) return;
    if (!this.phase || this.state.ended) {
      const from = this.state.ended || this.state.index < 0 ? 0 : this.state.index;
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
    const index = nextIndex(this.lines, Math.max(this.state.index, -1), this.part);
    if (index === null) return;
    this.seekToSegment(index, this.state.playing);
  }

  previous() {
    const phase = this.phase;
    const elapsed = phase?.kind === "line" ? this.audio.currentTime * 1000 : phase?.kind === "pause" ? Infinity : 0;
    const index = previousIndex(this.state.index, elapsed);
    this.seekToSegment(index, this.state.playing);
  }

  private playUrl(url: string, opts: { loop?: boolean; rate?: number } = {}) {
    const token = this.token;
    this.audio.loop = Boolean(opts.loop);
    if (this.audio.src !== url) {
      this.switchedAt = performance.now();
      this.audio.src = url;
    } else {
      this.audio.currentTime = 0;
    }
    // Loading a new src resets playbackRate to defaultPlaybackRate, so set both.
    const rate = opts.rate ?? 1;
    this.audio.defaultPlaybackRate = rate;
    this.audio.playbackRate = rate;
    void this.audio.play().catch((err: unknown) => {
      // A newer src aborts the previous play(); only a refusal (no user gesture yet) stops playback.
      if (token === this.token && !(err instanceof DOMException && err.name === "AbortError")) this.set({ playing: false });
    });
  }

  private applyRate(mine: boolean) {
    const rate = mine ? 1 : this.speed;
    this.audio.defaultPlaybackRate = rate;
    this.audio.playbackRate = rate;
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
   * Starts a line: its clip, a wait for it, or the listener's speaking pause. Synchronous up to
   * audio.play(), so a tap starts audio inside its gesture. Without autoplay it only moves there;
   * play() starts it. A line that is left out moves on to the next one that plays.
   */
  private startLine(requested: number, autoplay: boolean) {
    this.cancelGap();
    const token = ++this.token;
    const index = playableFrom(this.lines, requested, this.part);
    if (index === null) {
      this.phase = null;
      this.audio.pause();
      this.set({ index: this.lines.length - 1, playing: false, ended: true, gap: null, waiting: false });
      return;
    }
    const line = this.lines[index]!;
    this.set({ index, ended: false, gap: null, playing: autoplay, waiting: false });
    this.prefetchFrom(index);
    if (!autoplay) {
      this.phase = null;
      this.audio.pause();
      return;
    }
    const clip = this.clips.ready(line.lineId);
    const step = stepFor(this.lines, index, this.part, clip && recorded(clip.source) ? clip.durationMs : null);
    if (step.kind === "speak") {
      this.phase = step;
      this.set({ gap: { index, durationMs: step.durationMs, endsAt: performance.now() + step.durationMs, remainingMs: step.durationMs } });
      this.gapListener?.start(this.gapLine(index), step.durationMs);
      this.playUrl(silenceUrl(step.durationMs));
      return;
    }
    this.playClip(index, token, false);
  }

  /** The line's own audio: at once when it's here, else a short silence loops until it is. */
  private playClip(index: number, token: number, afterSpeak: boolean) {
    const line = this.lines[index]!;
    const mine = isMine(this.part, line);
    const clip = this.clips.ready(line.lineId);
    if (clip) {
      this.phase = { kind: "line", index };
      this.set({ waiting: false });
      const rate = mine ? 1 : this.speed;
      this.playUrl(clip.url ?? silenceUrl(clip.durationMs), { rate });
      return;
    }
    this.phase = { kind: "wait", index, afterSpeak };
    this.set({ waiting: true });
    this.playUrl(silenceUrl(WAIT_LOOP_MS), { loop: true });
    void this.clips.load(line.lineId).then(() => {
      if (token !== this.token || this.phase?.kind !== "wait") return;
      if (afterSpeak) this.playClip(index, token, true);
      else this.startLine(index, this.state.playing);
    });
  }

  private prefetchFrom(index: number) {
    this.clips.prefetch(prefetchWindow(this.lines, index, PREFETCH_LINES, this.part));
    this.clips.warm(prefetchWindow(this.lines, index, WARM_LINES, this.part));
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
      // The listener has had their turn; now their line plays ("pause"), or the play moves on ("skip").
      if (phase.then === "read") {
        this.playClip(phase.index, this.token, true);
        return;
      }
    }
    const next = nextIndex(this.lines, phase.index, this.part);
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
    this.playClip(phase.index, ++this.token, false);
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
