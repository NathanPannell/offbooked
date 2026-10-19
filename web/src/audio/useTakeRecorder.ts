import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage } from "../api/client";
import { MicError, MicSession, type ActiveTake, type RecordedTake } from "./recorder";
import { useWakeLock } from "./wakeLock";

/** Only a safety net for a take left running by mistake: real takes never get near it. */
export const MAX_TAKE_MS = 60 * 60 * 1000;
export const MIN_TAKE_MS = 400;

export type MicStatus = "idle" | "requesting" | "ready";

/**
 * One take at a time from a shared mic: asks for the mic on the first tap, keeps the screen awake
 * while recording, stops itself at the time limit. Used by the actor's recorder and the director's
 * stand-in recorder.
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
    const mic = (micRef.current ??= new MicSession());
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
  const stop = useCallback(async (): Promise<(RecordedTake & { tooShort: boolean }) | null> => {
    const take = takeRef.current;
    takeRef.current = null;
    setRecording(null);
    if (!take) return null;
    const recorded = await take.stop();
    return { ...recorded, tooShort: recorded.durationMs < MIN_TAKE_MS || recorded.blob.size === 0 };
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
  const stop = useCallback(() => {
    for (const a of players.current) a.pause();
  }, []);
  useEffect(() => () => stop(), [stop]);
  const start = useCallback(
    (urls: string[]) => {
      stop();
      while (players.current.length < urls.length) players.current.push(new Audio());
      urls.forEach((url, i) => {
        const a = players.current[i]!;
        a.src = url;
        a.currentTime = 0;
        void a.play().catch(() => {});
      });
    },
    [stop],
  );
  /** Plays one clip and resolves when it ends (or fails), e.g. a cue before recording. */
  const playThrough = useCallback(
    (url: string) =>
      new Promise<void>((resolve) => {
        stop();
        const a = (players.current[0] ??= new Audio());
        a.src = url;
        a.currentTime = 0;
        a.onended = () => resolve();
        a.onerror = () => resolve();
        a.onpause = () => resolve();
        void a.play().catch(() => resolve());
      }),
    [stop],
  );
  return { start, stop, playThrough };
}
