import type { SttModel } from "./models";

/** Milliseconds since the worker started, logged once the model is ready. */
export interface LoadTimings {
  start: number;
  /** Every file came from the Cache API. */
  cached?: boolean;
  /** Both ONNX sessions are created. */
  sessions?: number;
  /** The warm-up run finished. */
  ready?: number;
}

export type ToWorker =
  | { type: "load"; model: SttModel }
  | { type: "transcribe"; jobId: string; audio: Float32Array; expected: string }
  | { type: "cancel"; jobId: string }
  | { type: "dispose" };

export type FromWorker =
  | { type: "progress"; loaded: number; total: number }
  | { type: "ready"; timings?: LoadTimings }
  | { type: "result"; jobId: string; text: string }
  | { type: "error"; jobId?: string; message: string };
