import { useCallback, useEffect, useRef, useState } from "react";
import type { PracticeResult } from "../api/types";
import { MicError, MicSession, type ActiveTake } from "../audio/recorder";
import { useSttSession } from "../stt/useStt";
import type { GapListener } from "./engine";

export interface PracticeState {
  enabled: boolean;
  micError: MicError | null;
  results: Map<string, PracticeResult>;
  pending: number;
}

/**
 * "Score me" for my-part mode: records the mic during each of the actor's gaps (one
 * MediaRecorder per gap) and scores it on-device against the line.
 */
export function usePractice(lineText: (lineId: string) => string) {
  const { session: stt, state: sttState } = useSttSession();
  const micRef = useRef<MicSession | null>(null);
  const takeRef = useRef<ActiveTake | null>(null);
  const textRef = useRef(lineText);
  textRef.current = lineText;
  const [enabled, setEnabled] = useState(false);
  const [micError, setMicError] = useState<MicError | null>(null);
  const [results, setResults] = useState(new Map<string, PracticeResult>());
  const [pending, setPending] = useState(0);
  const enabledRef = useRef(false);
  enabledRef.current = enabled;

  /** Call from a tap: opens the mic (with echo cancellation, since the run-through is playing) and loads the model. */
  const enable = useCallback(async () => {
    setMicError(null);
    // Echo cancellation and noise suppression keep the run-through out of the recording.
    micRef.current ??= new MicSession({ echoCancellation: true, noiseSuppression: true, autoGainControl: true });
    try {
      await micRef.current.open();
      setEnabled(true);
      void stt.start();
    } catch (err) {
      setMicError(err instanceof MicError ? err : new MicError("unknown", "The microphone didn't start."));
    }
  }, [stt]);

  const disable = useCallback(() => {
    takeRef.current?.cancel();
    takeRef.current = null;
    micRef.current?.close();
    micRef.current = null;
    setEnabled(false);
  }, []);

  const reset = useCallback(() => {
    setResults(new Map());
  }, []);

  useEffect(
    () => () => {
      takeRef.current?.cancel();
      micRef.current?.close();
    },
    [],
  );

  const gapListener: GapListener = {
    start: (_segment, durationMs) => {
      if (!enabledRef.current || !micRef.current) return;
      takeRef.current?.cancel();
      try {
        takeRef.current = micRef.current.start(durationMs + 1000, () => {});
      } catch {
        takeRef.current = null;
      }
    },
    end: (segment, completed) => {
      const take = takeRef.current;
      takeRef.current = null;
      if (!take) return;
      if (!completed) {
        take.cancel();
        return;
      }
      setPending((n) => n + 1);
      void take
        .stop()
        .then((recorded) => stt.score(`practice:${segment.lineId}`, recorded.blob, textRef.current(segment.lineId)))
        .then((result) => {
          if (result) {
            setResults((r) => new Map(r).set(segment.lineId, { lineId: segment.lineId, ...result }));
          }
        })
        .finally(() => setPending((n) => n - 1));
    },
  };

  return { enabled, enable, disable, micError, results, pending, reset, gapListener, sttState };
}
