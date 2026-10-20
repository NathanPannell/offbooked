// Playing a scene partner's cue before a take ("Hear my scene partners"): always to its very end,
// so the take only starts once the cue line has been heard in full.

/** The part of an <audio> element a cue uses (an HTMLAudioElement in the app, a fake in tests). */
export interface CueElement {
  src: string;
  currentTime: number;
  ended: boolean;
  play(): Promise<void>;
  pause(): void;
  onended: ((ev: Event) => unknown) | null;
  onerror: ((ev: Event | string) => unknown) | null;
  onpause: ((ev: Event) => unknown) | null;
  ontimeupdate: ((ev: Event) => unknown) | null;
}

export type CueEnd = "ended" | "stopped" | "failed";

/** How long the recorder waits to fetch a cue whose voice wasn't ready, before recording without it. */
export const CUE_FETCH_MS = 3000;

/**
 * Runs `load` with a signal that aborts when `signal` does (a tap on record) or after `timeoutMs`,
 * and resolves its answer, or null when it was cut short or failed: the take never waits on it.
 */
export function fetchOrGiveUp<T>(
  load: (signal: AbortSignal) => Promise<T>,
  {
    signal,
    timeoutMs = CUE_FETCH_MS,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  }: { signal?: AbortSignal; timeoutMs?: number; setTimer?: typeof setTimeout; clearTimer?: typeof clearTimeout } = {},
): Promise<T | null> {
  const inner = new AbortController();
  return new Promise<T | null>((resolve) => {
    let done = false;
    const finish = (value: T | null) => {
      if (done) return;
      done = true;
      clearTimer(timer);
      signal?.removeEventListener("abort", stop);
      inner.abort();
      resolve(value);
    };
    const stop = () => finish(null);
    const timer = setTimer(stop, timeoutMs);
    if (signal?.aborted) return stop();
    signal?.addEventListener("abort", stop);
    load(inner.signal).then(finish, () => finish(null));
  });
}

/** After the cue ends, this long before the take starts, so the mic doesn't catch the cue's last sound from the speaker. */
export const CUE_SETTLE_MS = 250;
/** A cue that stops moving for this long (the network stalled) is given up on. Never a playing cue. */
export const CUE_STALL_MS = 8000;
/** A pause the browser makes by itself (an interruption) is resumed this many times. */
const RESUMES = 2;

export interface CuePlay {
  /** Resolves once the cue has ended (and settled), failed, or been stopped. */
  done: Promise<CueEnd>;
  /** Stops it now: a tap on record, or leaving. */
  stop(): void;
}

/**
 * Plays `url` on `a` to its end. Only the clip's own end, an error or `stop()` finish it: no timer
 * cuts it short. A pause the browser makes itself (another sound, a call) resumes it; the pause
 * every browser fires just before `ended` is ignored. The only timer is for a cue that stops
 * moving altogether, so a stalled download never holds the take forever.
 */
export function playToEnd(
  a: CueElement,
  url: string,
  { settleMs = CUE_SETTLE_MS, stallMs = CUE_STALL_MS, setTimer = setTimeout, clearTimer = clearTimeout } = {},
): CuePlay {
  let finish: (end: CueEnd) => void = () => {};
  let finished = false;
  let stopping = false;
  let resumes = 0;
  let stall: ReturnType<typeof setTimeout> | null = null;
  const done = new Promise<CueEnd>((resolve) => {
    finish = (end) => {
      if (finished) return;
      finished = true;
      if (stall) clearTimer(stall);
      a.onended = a.onerror = a.onpause = a.ontimeupdate = null;
      if (end === "ended" && settleMs > 0) setTimer(() => resolve(end), settleMs);
      else resolve(end);
    };
  });
  const watch = () => {
    if (stall) clearTimer(stall);
    stall = setTimer(() => finish("failed"), stallMs);
  };
  a.onended = () => finish("ended");
  a.onerror = () => finish("failed");
  a.ontimeupdate = watch;
  a.onpause = () => {
    if (stopping || a.ended || finished) return;
    if (resumes++ >= RESUMES) return finish("failed");
    a.play().catch(() => finish("failed"));
  };
  a.src = url;
  a.currentTime = 0;
  watch();
  a.play().catch(() => finish("failed"));
  return {
    done,
    stop: () => {
      if (finished) return;
      stopping = true;
      a.pause();
      finish("stopped");
    },
  };
}
