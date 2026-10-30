import type { SpokenSegment, TrackItem } from "../api/types";
import { applySpeed, clampSpeed } from "../audio/speed";
import type { Clip, ClipLoader } from "./clips";
import {
  gapBetweenMs,
  isMine,
  nextIndex,
  NO_PART,
  playableFrom,
  prefetchWindow,
  previousIndex,
  sameLines,
  samePart,
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
  /** Playing from a listen track: one long source, which keeps going with the phone locked. */
  onTrack: boolean;
  /**
   * Playback stopped without the listener asking while the page was hidden (the phone locked):
   * the browser refused the next source, or the system paused it. Cleared once it plays again.
   */
  interrupted: boolean;
}

/** A listen track as the server gives it (see ListenTrack in api/types.ts). */
export interface TrackSource {
  url: string;
  items: TrackItem[];
}

/** A listen track placed in the play queue: each item knows its line's index. */
interface LoadedTrack {
  url: string;
  /** The URL without its signature: the same file asked for again has the same key. */
  key: string;
  items: (TrackItem & { index: number })[];
  /** Each line's first item (its "speak" pause, or its audio), by line index. */
  first: Map<number, number>;
  lastIndex: number;
  /** When its URL was handed over (Date.now()): see TRACK_URL_FRESH_MS. */
  at: number;
}

/**
 * Where playback is inside the current line, for highlighting its words. "clip": its audio is
 * playing (timeMs is media time, so it holds at any speed). "gap": the listener's silence on their
 * own line. "before": waiting for the clip. "after": the line is done, the pause before the next.
 */
export interface LinePosition {
  index: number;
  kind: "clip" | "gap" | "before" | "after";
  timeMs: number;
  durationMs: number;
  segments?: SpokenSegment[];
  /** A recorded take's word starts and speech stretches, when the server knows them. */
  wordStartsMs?: number[];
  speech?: { startMs: number; endMs: number }[];
}

/** Clips downloaded ahead of the current line, and lines the server is asked to make ahead. */
export const PREFETCH_LINES = 5;
/**
 * A track's URL is used for a new source only this long after it was handed over: the server signs
 * it for 6 hours, and the player asks for a stretch as soon as it opens, which may be long before
 * play. An older one plays line by line until the same track comes back with a fresh URL.
 */
export const TRACK_URL_FRESH_MS = 5 * 3600_000;
export const WARM_LINES = 25;
const WAIT_LOOP_MS = 250;

type Phase =
  | { kind: "line"; index: number; clip: Clip }
  | { kind: "wait"; index: number; afterSpeak: boolean } // the clip is loading; a short silence loops meanwhile
  | { kind: "speak"; index: number; durationMs: number; then: "read" | "next" } // the listener says their line; then it plays, or the next one does
  | { kind: "pause"; index: number; next: number } // the pause between two lines
  | { kind: "track"; index: number }; // playing from a listen track; the line follows its time

/** Recorded takes time the listener's pause; TTS and silent lines are timed from their words. */
const recorded = (source: string | undefined) => source === "actor" || source === "director";

const pageHidden = () => typeof document !== "undefined" && document.visibilityState === "hidden";

/**
 * Plays the run-through line by line through one <audio> element: each line's clip, then a short
 * silence, then the next. Pauses, the listener's speaking pauses and waits for a clip are silent
 * WAVs on the same element, so playback moves on from `ended` events alone and one tap unlocks it
 * for good. Other people's lines play at the chosen speed (pitch kept); the listener's own at 1×.
 *
 * With the phone locked, mobile browsers don't reliably let a page start a new source, so line by
 * line stops at the end of the clip that was playing. Given a listen track (addTrack: a stretch of
 * the play as one file, built by the server for this part and mode), the engine moves onto it at
 * the next line it covers and from then on only seeks: the current line, the gap meter and the
 * speed for each line follow the track's time (timeupdate, and animation frames while visible).
 * Each move onto a track costs one new source and no more: from a line that ends, the track is
 * entered in the pause before the next line (when the track holds that pause); a play after a
 * pause (a tap, or the lock screen's play) carries on from the same moment in the track.
 */
export class PlayerEngine {
  private lines: QueueLine[] = [];
  private part: Part = NO_PART;
  private speed = 1;
  private phase: Phase | null = null;
  private token = 0;
  private retried = new Set<string>();
  private switchedAt = 0;
  private state: PlayerState = { index: -1, playing: false, gap: null, ended: false, waiting: false, onTrack: false, interrupted: false };
  /** Listen tracks ready to play: the one playing (if any) and the newest. */
  private tracks: LoadedTrack[] = [];
  /** The track whose file is on the element, while the phase is "track". */
  private current: LoadedTrack | null = null;
  /** Tracks that failed to play, by key: never tried again on this screen. */
  private badTracks = new Set<string>();
  private frame = 0;
  /** The next item boundary in the track, while it plays (see syncTrack). */
  private boundary: ReturnType<typeof setTimeout> | undefined;
  private listeners = new Set<() => void>();

  constructor(
    private audio: HTMLAudioElement,
    private clips: ClipLoader,
    private hidden: () => boolean = pageHidden,
  ) {
    audio.addEventListener("ended", this.onEnded);
    audio.addEventListener("play", this.onPlay);
    audio.addEventListener("pause", this.onPause);
    audio.addEventListener("error", this.onError);
    audio.addEventListener("timeupdate", this.onTimeUpdate);
    applySpeed(audio, 1);
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
    // Tracks are placed by line index; a changed script needs new ones.
    if (this.tracks.length && !sameLines(this.lines, lines)) this.clearTracks();
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
    // A track is built for one part and mode: another one needs its own.
    if (!samePart(before, part) && this.tracks.length) this.clearTracks();
    const phase = this.phase;
    if (!phase) return;
    if (phase.kind === "track") {
      this.syncTrack();
      return;
    }
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

  /** Playback speed for other people's lines (0.5× to 4×). */
  setSpeed(speed: number) {
    this.speed = clampSpeed(speed);
    const phase = this.phase;
    if (phase?.kind === "line") this.applyRate(isMine(this.part, this.lines[phase.index]));
    else if (phase?.kind === "track") this.syncTrack();
  }

  /**
   * A listen track for the current part and mode. Playback moves onto it at the next line it
   * covers (or at once, from a pause). The same file asked for again only freshens its URL, and
   * not while it plays (that would be a new source) unless the one it has is too old to use.
   */
  addTrack(source: TrackSource) {
    const key = source.url.split("?")[0]!;
    if (this.badTracks.has(key)) return;
    const same = this.tracks.find((t) => t.key === key);
    if (same) {
      if (same !== this.current || this.stale(same)) Object.assign(same, { url: source.url, at: Date.now() });
      return;
    }
    const byLine = new Map(this.lines.map((l, i) => [l.lineId, i]));
    const items = source.items.flatMap((item) => {
      const index = byLine.get(item.lineId);
      return index === undefined ? [] : [{ ...item, index }];
    });
    if (!items.length) return;
    const first = new Map<number, number>();
    items.forEach((item, i) => {
      if (!first.has(item.index)) first.set(item.index, i);
    });
    const track: LoadedTrack = { url: source.url, key, items, first, lastIndex: items[items.length - 1]!.index, at: Date.now() };
    // Keep the one playing; a newer one replaces any other.
    this.tracks = [...this.tracks.filter((t) => t === this.current), track];
  }

  /** Drops every track; if one is playing, carries on line by line from the current line. */
  clearTracks() {
    this.tracks = [];
    if (this.phase?.kind === "track") this.leaveTrack();
    this.current = null;
  }

  /** The last line of the track that would play this line, or null when none covers it. */
  trackReach(index: number): number | null {
    return this.trackFor(index)?.lastIndex ?? null;
  }

  /** Where playback is inside the current line (see LinePosition), or null when stopped. */
  position(): LinePosition | null {
    const phase = this.phase;
    if (!phase) return null;
    const timeMs = this.audio.currentTime * 1000;
    switch (phase.kind) {
      case "line": {
        const { clip } = phase;
        // A silent stand-in (no url) has none of its clip's timings.
        const timings = clip.url ? { segments: clip.segments, wordStartsMs: clip.wordStartsMs, speech: clip.speech } : {};
        return { index: phase.index, kind: "clip", timeMs, durationMs: clip.durationMs, ...timings };
      }
      case "speak":
        return { index: phase.index, kind: "gap", timeMs, durationMs: phase.durationMs };
      case "wait":
        return { index: phase.index, kind: phase.afterSpeak ? "after" : "before", timeMs: 0, durationMs: 0 };
      case "pause":
        return { index: phase.index, kind: "after", timeMs: 0, durationMs: 0 };
      case "track": {
        const item = this.trackItem();
        if (!item) return null;
        const into = timeMs - item.startMs;
        if (into >= item.durationMs) return { index: item.index, kind: "after", timeMs: 0, durationMs: 0 };
        if (item.kind === "speak") return { index: item.index, kind: "gap", timeMs: into, durationMs: item.durationMs };
        return {
          index: item.index,
          kind: "clip",
          timeMs: into,
          durationMs: item.durationMs,
          segments: item.segments,
          wordStartsMs: item.wordStartsMs,
          speech: item.speech,
        };
      }
    }
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
    // Paused line by line with a track ready for this point: carry on from the same moment in the
    // track, so the play needs no new source after this one (the phone may be locked by then).
    const at = this.trackPoint();
    if (at) {
      this.cancelGap();
      ++this.token;
      this.set({ playing: true, ended: false, interrupted: false });
      this.playTrackAt(at.index, at.track, at.ms);
      return;
    }
    const token = this.token;
    this.set({ playing: true, ended: false, interrupted: false });
    void this.audio.play().catch((err: unknown) => {
      // A pause before it started aborts it: the listener's own, never an interruption.
      if (token === this.token && !(err instanceof DOMException && err.name === "AbortError")) this.set({ playing: false, interrupted: this.hidden() });
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
    const elapsed =
      phase?.kind === "track" ? this.trackElapsedMs() : phase?.kind === "line" ? this.audio.currentTime * 1000 : phase?.kind === "pause" ? Infinity : 0;
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
    // Loading a new src resets playbackRate to defaultPlaybackRate; applySpeed sets both.
    applySpeed(this.audio, opts.rate ?? 1);
    this.startPlaying(token);
  }

  /**
   * Plays the element. A newer src aborts the previous play(); only a refusal stops playback: no
   * user gesture yet, or (marked `interrupted`) a locked phone that won't start the new source.
   */
  private startPlaying(token: number) {
    void this.audio.play().catch((err: unknown) => {
      if (token === this.token && !(err instanceof DOMException && err.name === "AbortError")) this.set({ playing: false, interrupted: this.hidden() });
    });
  }

  private applyRate(mine: boolean) {
    applySpeed(this.audio, mine ? 1 : this.speed);
  }

  private cancelGap() {
    const phase = this.phase;
    if (phase?.kind === "speak") this.set({ gap: null });
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
    // Only a play clears `interrupted`: a move while stopped (a clip that arrives after a refused
    // play, a seek) leaves the note for when the listener is back.
    this.set({ index, ended: false, gap: null, playing: autoplay, waiting: false, onTrack: false, ...(autoplay ? { interrupted: false } : {}) });
    const track = this.trackFor(index);
    if (autoplay && track) {
      this.playTrackAt(index, track);
      return;
    }
    if (!track) this.prefetchFrom(index);
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
      this.phase = { kind: "line", index, clip };
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
    if (phase.kind === "track") {
      this.trackEnded();
      return;
    }
    if (phase.kind === "pause") {
      this.startLine(phase.next, true);
      return;
    }
    if (phase.kind === "wait") return;
    if (phase.kind === "speak") {
      this.set({ gap: null });
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
    if (this.enterTrackBefore(phase.index, next)) return;
    this.phase = { kind: "pause", index: phase.index, next };
    this.playUrl(silenceUrl(gapBetweenMs(this.lines, phase.index, next)));
  };

  private onPlay = () => {
    if (this.phase?.kind === "track") {
      this.set({ playing: true, ended: false, interrupted: false });
      this.syncTrack();
      this.startFrames();
      return;
    }
    const gap = this.state.gap;
    this.set({
      playing: true,
      ended: false,
      interrupted: false,
      gap: gap ? { ...gap, endsAt: performance.now() + gap.remainingMs } : null,
    });
  };

  private onPause = () => {
    clearTimeout(this.boundary);
    const gap = this.state.gap;
    if (gap && this.phase?.kind === "track") this.set({ gap: { ...gap, endsAt: null } });
    if (gap && this.phase?.kind === "speak") {
      const remainingMs = Math.max(0, gap.durationMs - this.audio.currentTime * 1000);
      this.set({ gap: { ...gap, endsAt: null, remainingMs } });
    }
    // The end of each clip, and switching src, pause the element without the listener asking.
    // Anything else (the OS, a headset button, another tab's audio) stops playback; a pause the
    // engine made itself (pause(), a seek while paused) has already stopped it.
    if (this.audio.ended || performance.now() - this.switchedAt < 150 || !this.state.playing) return;
    this.set({ playing: false, interrupted: this.hidden() });
  };

  // A signed URL that expired, or a clip that won't decode: fetch it again once, else skip it.
  private onError = () => {
    const phase = this.phase;
    // A track that won't play (its link expired, a network error): line by line from here, and
    // never that track again.
    if (phase?.kind === "track") {
      const bad = this.current;
      if (bad) this.badTracks.add(bad.key);
      this.tracks = this.tracks.filter((t) => t !== bad);
      this.leaveTrack();
      return;
    }
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

  // Listen tracks ----------------------------------------------------------------------------

  private stale(track: LoadedTrack): boolean {
    return Date.now() - track.at > TRACK_URL_FRESH_MS;
  }

  /** The track to play this line from: the one playing when it covers it, else another. Never one whose URL is too old. */
  private trackFor(index: number): LoadedTrack | null {
    const covers = (t: LoadedTrack) => t.first.has(index) && !this.stale(t);
    if (this.current && covers(this.current)) return this.current;
    return [...this.tracks].reverse().find(covers) ?? null;
  }

  /**
   * Where a line-by-line pause would carry on in a track that covers it: the same moment in the
   * line's audio or its speaking pause; the start of the line's audio while waiting for it after
   * that pause; else the start of the line (waiting for it, or in the pause before it). Null when
   * on a track already or none covers it.
   */
  private trackPoint(): { index: number; track: LoadedTrack; ms: number } | null {
    const phase = this.phase;
    if (!phase || phase.kind === "track") return null;
    const index = phase.kind === "pause" ? phase.next : phase.index;
    const track = this.trackFor(index);
    if (!track) return null;
    const kind = phase.kind === "speak" ? "speak" : phase.kind === "line" || (phase.kind === "wait" && phase.afterSpeak) ? "line" : null;
    const item = kind && track.items.find((i) => i.index === index && i.kind === kind);
    if (item) {
      const into = phase.kind === "wait" ? 0 : Math.min(this.audio.currentTime * 1000, item.durationMs);
      return { index, track, ms: item.startMs + into };
    }
    return { index, track, ms: track.items[track.first.get(index)!]!.startMs };
  }

  /**
   * After line `from` ends line by line: onto a track that covers `next` and holds the pause
   * before it, at the start of that pause, so the pause and what follows need no new source.
   */
  private enterTrackBefore(from: number, next: number): boolean {
    const track = this.trackFor(next);
    if (!track) return false;
    const atMs = track.items[track.first.get(next)!]!.startMs - gapBetweenMs(this.lines, from, next);
    if (atMs < 0) return false;
    ++this.token;
    this.playTrackAt(next, track, atMs);
    return true;
  }

  /** Plays the track from this line's first item, or `atMs` into it. Synchronous up to play(), like startLine. */
  private playTrackAt(index: number, track: LoadedTrack, atMs?: number) {
    const token = this.token;
    const item = track.items[track.first.get(index)!]!;
    this.phase = { kind: "track", index };
    this.audio.loop = false;
    if (this.current !== track || this.audio.src !== track.url) {
      this.switchedAt = performance.now();
      this.audio.src = track.url;
    }
    this.current = track;
    this.seek((atMs ?? item.startMs) / 1000);
    this.set({ onTrack: true, waiting: false });
    this.syncTrack();
    this.prefetchPastTrack(index);
    this.startPlaying(token);
    this.startFrames();
  }

  /** How far into the current line's audio the track is (Infinity in the pause after it, 0 in a speaking pause). */
  private trackElapsedMs(): number {
    const pos = this.position();
    return pos?.kind === "clip" ? pos.timeMs : pos?.kind === "after" ? Infinity : 0;
  }

  /** Moves the element to a time, now, or once it knows the file's length (unless its source changed by then). */
  private seek(seconds: number) {
    const src = this.audio.src;
    const to = () => {
      if (this.audio.src !== src) return;
      try {
        this.audio.currentTime = seconds;
      } catch {
        // Not seekable yet: loadedmetadata sets it.
      }
    };
    to();
    if (!(this.audio.readyState >= 1)) this.audio.addEventListener("loadedmetadata", to, { once: true });
  }

  /** The item playing now (or the last one before the gap that is playing). */
  private trackItem(): (TrackItem & { index: number }) | null {
    const slot = this.trackSlot();
    return slot === null ? null : this.current!.items[slot]!;
  }

  /** Where trackItem's item sits in the current track's items. */
  private trackSlot(): number | null {
    const items = this.current?.items;
    if (!items?.length) return null;
    const ms = this.audio.currentTime * 1000;
    let lo = 0;
    let hi = items.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (items[mid]!.startMs <= ms) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }

  /**
   * Follows the track's time: the current line, the speed for it, and the listener's pause. Runs on
   * timeupdate and animation frames, and once more at the next item boundary: with the phone
   * locked there are no frames and timeupdate comes about 4 times a second, so at 4× up to a second
   * of the next item would play at the wrong speed (the listener's pause cut short). The timer only
   * changes the speed and the line shown; playback never waits on it.
   */
  private syncTrack() {
    clearTimeout(this.boundary);
    this.boundary = undefined;
    if (this.phase?.kind !== "track") return;
    const slot = this.trackSlot();
    if (slot === null) return;
    const item = this.current!.items[slot]!;
    const ms = this.audio.currentTime * 1000;
    const inside = ms < item.startMs + item.durationMs;
    if (item.index !== this.phase.index || item.index !== this.state.index) {
      this.phase = { kind: "track", index: item.index };
      this.set({ index: item.index });
      this.prefetchPastTrack(item.index);
    }
    const rate = inside && item.kind === "line" && !isMine(this.part, this.lines[item.index]) ? this.speed : 1;
    if (this.audio.playbackRate !== rate) applySpeed(this.audio, rate);
    const gap = this.state.gap;
    if (inside && item.kind === "speak") {
      const remainingMs = Math.max(0, item.startMs + item.durationMs - ms);
      const playing = this.state.playing;
      if (!gap || gap.index !== item.index || (gap.endsAt === null) === playing) {
        this.set({ gap: { index: item.index, durationMs: item.durationMs, endsAt: playing ? performance.now() + remainingMs : null, remainingMs } });
      }
    } else if (gap) this.set({ gap: null });
    const boundaryMs = inside ? item.startMs + item.durationMs : this.current!.items[slot + 1]?.startMs;
    if (this.state.playing && boundaryMs !== undefined && boundaryMs > ms) {
      this.boundary = setTimeout(() => this.syncTrack(), (boundaryMs - ms) / (this.audio.playbackRate || 1) + 1);
    }
  }

  /** Near the end of the track, fetch the lines after it, in case no newer track is ready by then. */
  private prefetchPastTrack(index: number) {
    const track = this.current;
    if (!track || track.lastIndex - index > PREFETCH_LINES) return;
    const after = nextIndex(this.lines, track.lastIndex, this.part);
    if (after !== null && !this.trackFor(after)) this.prefetchFrom(after);
  }

  /** The track has played to its end: on to the next line, from a newer track when there is one. */
  private trackEnded() {
    const last = this.current?.lastIndex ?? this.state.index;
    this.set({ onTrack: false, gap: null });
    const next = nextIndex(this.lines, last, this.part);
    if (next === null) {
      this.phase = null;
      this.set({ playing: false, ended: true });
      return;
    }
    // A newer track that already covers the end of this one goes on from inside it: one new source.
    if (this.enterTrackBefore(last, next)) return;
    this.phase = { kind: "pause", index: last, next };
    this.playUrl(silenceUrl(gapBetweenMs(this.lines, last, next)));
  }

  /** Off the track (it changed or failed): the current line again, line by line. */
  private leaveTrack() {
    this.current = null;
    this.set({ onTrack: false, gap: null });
    if (this.state.index >= 0) this.startLine(this.state.index, this.state.playing);
    else this.phase = null;
  }

  private onTimeUpdate = () => this.syncTrack();

  /** While visible, follows the track every frame (timeupdate alone is about 4 a second). */
  private startFrames() {
    if (this.frame || typeof requestAnimationFrame !== "function") return;
    const loop = () => {
      this.frame = 0;
      if (this.phase?.kind !== "track" || !this.state.playing) return;
      this.syncTrack();
      this.frame = requestAnimationFrame(loop);
    };
    this.frame = requestAnimationFrame(loop);
  }

  destroy() {
    this.token++;
    clearTimeout(this.boundary);
    if (this.frame && typeof cancelAnimationFrame === "function") cancelAnimationFrame(this.frame);
    this.audio.removeEventListener("timeupdate", this.onTimeUpdate);
    this.audio.removeEventListener("ended", this.onEnded);
    this.audio.removeEventListener("play", this.onPlay);
    this.audio.removeEventListener("pause", this.onPause);
    this.audio.removeEventListener("error", this.onError);
    this.audio.pause();
    this.listeners.clear();
  }
}
