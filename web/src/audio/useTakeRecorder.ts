import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage } from "../api/client";
import { MicError, MicSession, type ActiveTake, type RecordedTake } from "./recorder";
import { holdWakeLock } from "./wakeLock";

export const MAX_TAKE_MS = 2 * 60 * 1000;
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
  const releaseWakeLock = useRef<() => void>(() => {});
  const onLimitRef = useRef(onLimit);
  onLimitRef.current = onLimit;
  const [recording, setRecording] = useState<{ lineId: string; startedAt: number } | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [micStatus, setMicStatus] = useState<MicStatus>("idle");
  const [micError, setMicError] = useState<MicError | null>(null);

  useEffect(
    () => () => {
      takeRef.current?.cancel();
      micRef.current?.close();
      releaseWakeLock.current();
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
    releaseWakeLock.current = holdWakeLock();
    setElapsed(0);
    setRecording({ lineId, startedAt: performance.now() });
    return true;
  }, []);

  /** Stops the take. Resolves null when nothing was recording or the take was too short to keep. */
  const stop = useCallback(async (): Promise<(RecordedTake & { tooShort: boolean }) | null> => {
    const take = takeRef.current;
    takeRef.current = null;
    releaseWakeLock.current();
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
    start,
    stop,
  };
}

/** One shared <audio> for previews (takes and cues), so only one thing plays at a time. */
export function usePlayback(onError?: () => void) {
  const player = useRef<HTMLAudioElement | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;

  useEffect(() => () => player.current?.pause(), []);

  const play = useCallback(
    (key: string, url: string) => {
      const audio = (player.current ??= new Audio());
      if (playing === key) {
        audio.pause();
        setPlaying(null);
        return;
      }
      audio.src = url;
      audio.onended = () => setPlaying(null);
      audio.onpause = () => setPlaying((p) => (p === key ? null : p));
      audio.play().then(
        () => setPlaying(key),
        () => onErrorRef.current?.(),
      );
    },
    [playing],
  );

  const pause = useCallback(() => player.current?.pause(), []);

  return { playing, play, pause };
}
