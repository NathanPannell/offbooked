import { useEffect, useRef, useState } from "react";
import { CAPTURE_RATE, type LiveCapture } from "../audio/liveCapture";
import {
  applyPass,
  decideAdvance,
  nextPassInterval,
  passWindowSeconds,
  rmsDb,
  segmentLine,
  SPEECH_MS_PER_WORD,
  startProgress,
  startVad,
  VAD_MIN_RUN_MS,
  vadStep,
} from "./live";
import { prepareForAsr } from "./prepare";
import type { SttSession } from "./session";
import { addVoiced, notePass, startWordClock, type TakeTiming } from "./wordTiming";

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
  /** When false, words still light up but the take never stops by itself. */
  autoAdvance: boolean;
  /** The actor has finished: stop, keep the take and move on. */
  onAdvance: (lineId: string, mode: LiveTakeView["mode"]) => void;
  /** Filled while a take records with what timing its words needs (`takeWordStarts`); kept after it stops. */
  timingRef?: { current: TakeTiming | null };
}

/**
 * Follows the take that is recording: re-transcribes the growing audio every few hundred ms in the
 * speech worker, aligns it with the line to light up spoken words, and watches the mic level to
 * end the take after a pause once the actor has spoken; the transcript only sets how long that
 * pause is. Without the model it only watches the level.
 */
export function useLiveTake({ recording, capture, analyser, stt, text, autoAdvance, onAdvance, timingRef }: Options): LiveTakeView | null {
  const [view, setView] = useState<LiveTakeView | null>(null);
  const autoRef = useRef(autoAdvance);
  autoRef.current = autoAdvance;
  const advanceRef = useRef(onAdvance);
  advanceRef.current = onAdvance;
  const textRef = useRef(text);
  textRef.current = text;
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
    let progress = startProgress(tokens.length);
    let vad = startVad();
    let covered = 0; // samples the newest finished pass covered
    let decided = false;
    let stopped = false;
    let mode: LiveTakeView["mode"] = capture && stt.getState().status === "ready" ? "live" : "energy";
    const latencies: number[] = [];
    const controller = new AbortController();
    const cleanups: (() => void)[] = [];

    // Word timing: the capture's samples start about now, a moment after the recording did.
    const timing: TakeTiming = {
      lineId,
      text: textRef.current,
      offsetMs: startedAt === null ? 0 : Math.max(0, performance.now() - startedAt),
      clock: startWordClock(),
      stretches: [],
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
      const decision = decideAdvance({
        mode,
        totalTokens: tokens.length,
        cursor: progress.cursor,
        speechMs: vad.speechMs,
        silenceMs: vad.silenceMs,
        caughtUp: covered >= (vad.lastSpeechAtMs / 1000) * CAPTURE_RATE,
      });
      if (decision === "wait") return;
      decided = true;
      advanceRef.current(lineId, mode);
    };

    // Mic level: from the captured samples, or by polling the level meter where AudioWorklet is missing.
    if (capture) {
      const take = capture.begin();
      cleanups.push(() => capture.end(take));
      cleanups.push(
        capture.onChunk((chunk) => {
          for (let start = 0; start < chunk.length; start += FRAME_SAMPLES) {
            const end = Math.min(chunk.length, start + FRAME_SAMPLES);
            vad = vadStep(vad, rmsDb(chunk, start, end), ((end - start) / CAPTURE_RATE) * 1000);
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
    let wake: (() => void) | null = null;
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
          if (!prepared.noSpeech) {
            const passStart = performance.now();
            const heard = await stt.transcribeLive(prepared.audio, controller.signal);
            if (stopped) return;
            if (heard !== null) {
              latency = performance.now() - passStart;
              latencies.push(latency);
              const before = progress.cursor;
              progress = applyPass(progress, tokens, heard, windowed);
              // The words this pass reached were said in the audio it heard (taken before the pass ran).
              timing.clock = notePass(timing.clock, before, progress.cursor, (from / CAPTURE_RATE) * 1000, (total / CAPTURE_RATE) * 1000);
            }
          }
          covered = total;
          publish();
          evaluate();
        }
        await sleep(Math.max(0, nextPassInterval(latency) - (performance.now() - began)));
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
