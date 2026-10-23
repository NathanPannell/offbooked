import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage } from "../api/client";
import { silenceUrl } from "../player/silence";
import { playToEnd, type CueEnd, type CuePlay } from "./cue";
import { rememberedMic, rememberMic } from "./micPrefs";
import { micConstraints, MicError, MicSession, type ActiveTake, type RecordedTake } from "./recorder";
import { useWakeLock } from "./wakeLock";

/** Only a safety net for a take left running by mistake: real takes never get near it. */
export const MAX_TAKE_MS = 60 * 60 * 1000;
export const MIN_TAKE_MS = 400;

export type MicStatus = "idle" | "requesting" | "ready";

export type FinishedTake = RecordedTake & { tooShort: boolean };

const finished = (recorded: RecordedTake): FinishedTake => ({
  ...recorded,
  tooShort: recorded.durationMs < MIN_TAKE_MS || recorded.blob.size === 0,
});

/** Stops `current` once `next` is really recording, so the two overlap and no audio falls between them. */
export function overlapTakes(current: ActiveTake, next: ActiveTake): Promise<RecordedTake> {
  return next.started.then(() => current.stop());
}

/**
 * One take at a time from a shared mic: asks for the mic on the first tap, keeps the screen awake
 * while recording, stops itself at the time limit. Used by the actor's recorder and the director's
 * recorder.
 */
export function useTakeRecorder({ onLimit }: { onLimit?: (lineId: string) => void } = {}) {
  const micRef = useRef<MicSession | null>(null);
  const takeRef = useRef<ActiveTake | null>(null);
  const onLimitRef = useRef(onLimit);
  onLimitRef.current = onLimit;
  const [recording, setRecording] = useState<{ lineId: string; startedAt: number } | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [micStatus, setMicStatus] = useState<MicStatus>("idle");
  const [micError, setMicError] = useState<MicError | null>(null);
  useWakeLock(recording !== null);

  useEffect(
    () => () => {
      takeRef.current?.cancel();
      micRef.current?.close();
    },
    [],
  );

  useEffect(() => {
    if (!recording) return;
    const id = setInterval(() => setElapsed(performance.now() - recording.startedAt), 200);
    return () => clearInterval(id);
  }, [recording]);

  /** Starts recording a line. Resolves false when the mic couldn't start (see `micError`). */
  const start = useCallback(async (lineId: string): Promise<boolean> => {
    if (takeRef.current) return false;
    setMicError(null);
    const mic = (micRef.current ??= new MicSession(micConstraints(rememberedMic())));
    if (!mic.isOpen) {
      setMicStatus("requesting");
      try {
        await mic.open();
      } catch (err) {
        setMicStatus("idle");
        setMicError(err instanceof MicError ? err : new MicError("unknown", errorMessage(err)));
        return false;
      }
    }
    setMicStatus("ready");
    try {
      takeRef.current = mic.start(MAX_TAKE_MS, () => onLimitRef.current?.(lineId));
    } catch (err) {
      setMicError(err instanceof MicError ? err : new MicError("unknown", errorMessage(err)));
      return false;
    }
    setElapsed(0);
    setRecording({ lineId, startedAt: performance.now() });
    return true;
  }, []);

  /** Stops the take. Resolves null when nothing was recording or the take was too short to keep. */
  const stop = useCallback(async (): Promise<FinishedTake | null> => {
    const take = takeRef.current;
    takeRef.current = null;
    setRecording(null);
    if (!take) return null;
    return finished(await take.stop());
  }, []);

  /**
   * Hands the mic straight on to the next line: its take starts now, on the same open mic, and the
   * one recording stops only once the new one is really taking audio, so the two overlap by a few
   * ms and nothing said between them is lost. Returns the finished take, still being wrapped up
   * (null when nothing was recording or the next take couldn't start: then stop and start instead).
   */
  const handoff = useCallback((nextLineId: string): Promise<FinishedTake> | null => {
    const take = takeRef.current;
    const mic = micRef.current;
    if (!take || !mic?.isOpen) return null;
    let next: ActiveTake;
    try {
      next = mic.start(MAX_TAKE_MS, () => onLimitRef.current?.(nextLineId));
    } catch {
      return null;
    }
    takeRef.current = next;
    setElapsed(0);
    setRecording({ lineId: nextLineId, startedAt: performance.now() });
    return overlapTakes(take, next).then(finished);
  }, []);

  /** Remembers the mic picked in mic settings; the next take opens it. */
  const setDevice = useCallback((deviceId: string | null) => {
    rememberMic(deviceId);
    if (takeRef.current) return;
    micRef.current?.close();
    micRef.current = null;
    setMicStatus("idle");
  }, []);

  return {
    recording,
    elapsed,
    micStatus,
    micError,
    clearMicError: () => setMicError(null),
    analyser: micRef.current?.analyser ?? null,
    capture: micRef.current?.capture ?? null,
    start,
    stop,
    handoff,
    setDevice,
  };
}

/**
 * One shared player for previews (takes and cues), so only one thing plays at a time. `playTogether`
 * plays several clips at once (a shared line: your take with the others'). `progress` is how far the
 * playing clip has got, 0 to 1.
 */
export function usePlayback(onError?: () => void) {
  const players = useRef<HTMLAudioElement[]>([]);
  const [playing, setPlaying] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  const stopAll = useCallback(() => {
    for (const a of players.current) {
      a.onpause = null;
      a.onended = null;
      a.ontimeupdate = null;
      a.pause();
    }
  }, []);

  useEffect(() => () => stopAll(), [stopAll]);

  const playTogether = useCallback(
    (key: string, urls: string[]) => {
      stopAll();
      if (playing === key || urls.length === 0) {
        setPlaying(null);
        return;
      }
      while (players.current.length < urls.length) players.current.push(new Audio());
      const used = players.current.slice(0, urls.length);
      let left = used.length;
      setProgress(0);
      used.forEach((audio, i) => {
        audio.src = urls[i]!;
        audio.currentTime = 0;
        audio.onended = () => {
          if (--left === 0) setPlaying((p) => (p === key ? null : p));
        };
        audio.onpause = () => {
          if (!audio.ended) {
            stopAll();
            setPlaying((p) => (p === key ? null : p));
          }
        };
        // The longest clip drives the progress.
        audio.ontimeupdate = () => {
          const longest = used.reduce((a, b) => ((b.duration || 0) > (a.duration || 0) ? b : a));
          if (audio === longest && longest.duration) setProgress(Math.min(1, audio.currentTime / longest.duration));
        };
      });
      Promise.all(used.map((a) => a.play())).then(
        () => setPlaying(key),
        () => {
          stopAll();
          setPlaying(null);
          onErrorRef.current?.();
        },
      );
    },
    [playing, stopAll],
  );

  const play = useCallback((key: string, url: string) => playTogether(key, [url]), [playTogether]);

  const pause = useCallback(() => {
    stopAll();
    setPlaying(null);
  }, [stopAll]);

  return { playing, progress, play, playTogether, pause };
}

/**
 * Other people's takes playing along while you record a shared line (headphones on, or the mic hears
 * them). Separate from the preview player so a preview never cuts it off.
 */
export function useAccompaniment() {
  const players = useRef<HTMLAudioElement[]>([]);
  const cue = useRef<CuePlay | null>(null);
  const stop = useCallback(() => {
    cue.current?.stop();
    cue.current = null;
    for (const a of players.current) a.pause();
  }, []);
  useEffect(() => () => stop(), [stop]);
  const start = useCallback(
    (urls: string[]) => {
      stop();
      while (players.current.length < urls.length) players.current.push(new Audio());
      urls.forEach((url, i) => {
        const a = players.current[i]!;
        a.onended = a.onerror = a.onpause = a.ontimeupdate = null;
        a.src = url;
        a.currentTime = 0;
        void a.play().catch(() => {});
      });
    },
    [stop],
  );
  /**
   * Call from the record tap, before anything is awaited: iOS only lets an element play later (a
   * cue before the next take, when "Keep recording" moves on by itself) once it has played from a
   * tap, so a moment of silence plays on it now.
   */
  const unlock = useCallback(() => {
    const a = (players.current[0] ??= new Audio());
    if (cue.current || !a.paused) return;
    a.onended = a.onerror = a.onpause = a.ontimeupdate = null;
    a.src = silenceUrl(50);
    void a.play().catch(() => {});
  }, []);
  /**
   * Plays one clip to its very end (a cue before recording), then resolves; see `playToEnd`. Only
   * `stop()` cuts it short.
   */
  const playThrough = useCallback(
    async (url: string): Promise<CueEnd> => {
      stop();
      const play = playToEnd((players.current[0] ??= new Audio()), url);
      cue.current = play;
      const end = await play.done;
      if (cue.current === play) cue.current = null;
      return end;
    },
    [stop],
  );
  return { start, stop, playThrough, unlock };
}
