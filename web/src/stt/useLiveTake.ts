import { useEffect, useRef, useState } from "react";
import { CAPTURE_RATE, type LiveCapture } from "../audio/liveCapture";
import {
  advanceInput,
  applyPass,
  checkPass,
  clauseBreaks,
  decideAdvance,
  flubbed,
  nextPassInterval,
  passWindowSeconds,
  pauseBegan,
  rmsDb,
  segmentLine,
  SPEECH_MS_PER_WORD,
  startLineCheck,
  startProgress,
  startVad,
  VAD_MIN_RUN_MS,
  vadStep,
} from "./live";
import { prepareForAsr } from "./prepare";
import type { SttSession } from "./session";
import { addVoiced, type TakeTiming } from "./wordTiming";

const FRAME_SAMPLES = CAPTURE_RATE / 50; // 20 ms
const MIN_AUDIO_SAMPLES = CAPTURE_RATE / 2;
const MIN_NEW_SAMPLES = CAPTURE_RATE / 5;
const LEVEL_POLL_MS = 50;

export interface LiveTakeView {
  lineId: string;
  /** `live`: words light up as they're heard. `energy`: no transcript, only the mic level. */
  mode: "live" | "energy";
  /** Tokens [0, cursor) of the line count as spoken. */
  cursor: number;
  /**
   * Without a transcript, about how many tokens the actor has said by now, from their speech time
   * (an average reading pace). Only for keeping the line in view, never for ending the take.
   */
  paced: number;
}

export interface LiveTakeStats {
  passes: number;
  medianMs: number | null;
  maxMs: number | null;
}

interface Options {
  recording: { lineId: string; startedAt: number } | null;
  capture: LiveCapture | null;
  analyser: AnalyserNode | null;
  stt: SttSession;
  /** The text of the line being recorded. */
  text: string;
  /** Lines near it (its cue, the speaker's next line, the line after it), for the wrong-line check. */
  nearby?: readonly string[];
  /** When false, words still light up but the take never stops by itself. */
  autoAdvance: boolean;
  /** Check that the take was the line before moving on (`flubbed`). Only with the speech model. */
  checkLine?: boolean;
  /**
   * The actor has finished: stop, and keep the take and move on, unless `flub` (the wrong-line check
   * found it wasn't the line: then ask).
   */
  onAdvance: (lineId: string, mode: LiveTakeView["mode"], flub: boolean) => void;
  /** Filled while a take records with where Listen back should stop (`listenEndMs`); kept after it stops. */
  timingRef?: { current: TakeTiming | null };
}

/**
 * Follows the take that is recording: re-transcribes the growing audio every few hundred ms in the
 * speech worker and traces along the line (is the next word said?) to light up spoken words, and
 * watches the mic level to end the take after a pause once the actor has spoken; the transcript
 * only sets how long that pause is, and says whether the take was the line at all (the wrong-line
 * check, against the lines near it). Without the model it only watches the level.
 */
export function useLiveTake({
  recording,
  capture,
  analyser,
  stt,
  text,
  nearby = [],
  autoAdvance,
  checkLine = true,
  onAdvance,
  timingRef,
}: Options): LiveTakeView | null {
  const [view, setView] = useState<LiveTakeView | null>(null);
  const autoRef = useRef(autoAdvance);
  autoRef.current = autoAdvance;
  const advanceRef = useRef(onAdvance);
  advanceRef.current = onAdvance;
  const textRef = useRef(text);
  textRef.current = text;
  const nearbyRef = useRef(nearby);
  nearbyRef.current = nearby;
  const checkRef = useRef(checkLine);
  checkRef.current = checkLine;
  const timingOut = useRef(timingRef);
  timingOut.current = timingRef;

  const lineId = recording?.lineId ?? null;
  const startedAt = recording?.startedAt ?? null;

  useEffect(() => {
    if (!lineId) {
      setView(null);
      return;
    }
    const { tokens } = segmentLine(textRef.current);
    const breaks = clauseBreaks(textRef.current);
    let progress = startProgress(tokens.length);
    let check = startLineCheck(nearbyRef.current);
    let vad = startVad();
    let covered = 0; // samples the newest finished pass covered
    let coveredSpeechMs = 0; // voiced time in them
    let decided = false;
    let stopped = false;
    let mode: LiveTakeView["mode"] = capture && stt.getState().status === "ready" ? "live" : "energy";
    const latencies: number[] = [];
    const controller = new AbortController();
    const cleanups: (() => void)[] = [];

    // For Listen back: the capture's samples start about now, a moment after the recording did.
    const timing: TakeTiming = {
      lineId,
      offsetMs: startedAt === null ? 0 : Math.max(0, performance.now() - startedAt),
      stretches: [],
      lineEndMs: null,
    };
    if (timingOut.current) timingOut.current.current = timing;

    const paced = () => (mode === "energy" ? Math.min(tokens.length, Math.floor(vad.speechMs / SPEECH_MS_PER_WORD)) : progress.cursor);
    const publish = () => {
      const p = paced();
      setView((v) =>
        v && v.lineId === lineId && v.cursor === progress.cursor && v.mode === mode && v.paced === p ? v : { lineId, mode, cursor: progress.cursor, paced: p },
      );
    };
    publish();

    const evaluate = () => {
      if (decided || stopped || !autoRef.current) return;
      const decision = decideAdvance(
        advanceInput({ mode, tokens: tokens.length, breaks, progress, vad, coveredMs: (covered / CAPTURE_RATE) * 1000, coveredSpeechMs }),
      );
      if (decision === "wait") return;
      decided = true;
      advanceRef.current(lineId, mode, checkRef.current && mode === "live" && flubbed(check, progress));
    };

    // Transcription passes sleep between them; a pause in the voice wakes the loop (see PAUSE_PASS_MS).
    let wake: (() => void) | null = null;
    /** Capture length when the voice last paused. */
    let pauseAt = -1;

    // Mic level: from the captured samples, or by polling the level meter where AudioWorklet is missing.
    if (capture) {
      const take = capture.begin();
      cleanups.push(() => capture.end(take));
      cleanups.push(
        capture.onChunk((chunk) => {
          for (let start = 0; start < chunk.length; start += FRAME_SAMPLES) {
            const end = Math.min(chunk.length, start + FRAME_SAMPLES);
            const before = vad;
            vad = vadStep(vad, rmsDb(chunk, start, end), ((end - start) / CAPTURE_RATE) * 1000);
            if (pauseBegan(before, vad)) {
              pauseAt = capture.length;
              wake?.();
            }
            if (vad.runMs >= VAD_MIN_RUN_MS) addVoiced(timing.stretches, vad.elapsedMs - vad.runMs, vad.elapsedMs);
          }
          if (mode === "energy") publish();
          evaluate();
        }),
      );
    } else if (analyser) {
      const buffer = new Float32Array(analyser.fftSize);
      let last = performance.now();
      const id = setInterval(() => {
        const now = performance.now();
        analyser.getFloatTimeDomainData(buffer);
        vad = vadStep(vad, rmsDb(buffer), now - last);
        last = now;
        if (mode === "energy") publish();
        evaluate();
      }, LEVEL_POLL_MS);
      cleanups.push(() => clearInterval(id));
    }

    // Transcription passes, one at a time, paced by how long the last one took.
    const sleep = (ms: number) =>
      new Promise<void>((resolve) => {
        const id = setTimeout(resolve, ms);
        wake = () => {
          clearTimeout(id);
          resolve();
        };
      });
    cleanups.push(() => wake?.());

    const loop = async () => {
      let latency = 400;
      while (!stopped && capture) {
        const began = performance.now();
        const ready = stt.getState().status === "ready";
        if (ready && mode === "energy") {
          mode = "live"; // The model finished loading during this take.
          publish();
        }
        const total = capture.length;
        if (ready && vad.speechMs > 0 && total >= MIN_AUDIO_SAMPLES && total - covered >= MIN_NEW_SAMPLES) {
          const { full, window } = passWindowSeconds(latency);
          const windowed = total > full * CAPTURE_RATE;
          const from = windowed ? total - window * CAPTURE_RATE : 0;
          const prepared = prepareForAsr(capture.slice(from, total));
          // The VAD has heard the same audio by now: its voiced time is the pace this pass will show.
          const speechThen = vad.speechMs;
          if (!prepared.noSpeech) {
            const passStart = performance.now();
            const heard = await stt.transcribeLive(prepared.audio, controller.signal);
            if (stopped) return;
            if (heard !== null) {
              coveredSpeechMs = speechThen;
              latency = performance.now() - passStart;
              latencies.push(latency);
              const ended = progress.ended;
              progress = applyPass(progress, tokens, heard, windowed);
              check = checkPass(check, tokens, heard, windowed);
              if (!ended && progress.ended) timing.lineEndMs = (total / CAPTURE_RATE) * 1000;
            }
          }
          covered = total;
          publish();
          evaluate();
        }
        // A pause began after the audio this pass heard: hear it now rather than after the wait.
        await sleep(pauseAt > total ? 0 : Math.max(0, nextPassInterval(latency) - (performance.now() - began)));
      }
    };
    void loop();

    return () => {
      stopped = true;
      controller.abort();
      cleanups.forEach((c) => c());
      if (latencies.length > 0) {
        const stats = summarize(latencies);
        lastStats = stats;
        console.debug(`[live stt] ${stats.passes} passes, median ${stats.medianMs} ms, max ${stats.maxMs} ms`);
      }
    };
  }, [lineId, startedAt, capture, analyser, stt]);

  return view && view.lineId === lineId ? view : null;
}

let lastStats: LiveTakeStats | null = null;

/** Latency of the last take's live passes, for checking on a device. */
export function lastLiveTakeStats(): LiveTakeStats | null {
  return lastStats;
}

export function summarize(latencies: number[]): LiveTakeStats {
  const sorted = [...latencies].sort((a, b) => a - b);
  return {
    passes: sorted.length,
    medianMs: sorted.length ? Math.round(sorted[Math.floor(sorted.length / 2)]) : null,
    maxMs: sorted.length ? Math.round(sorted[sorted.length - 1]) : null,
  };
}
