import type { SttModel } from "./models";

export type ToWorker =
  | { type: "load"; model: SttModel }
  | { type: "transcribe"; jobId: string; audio: Float32Array; expected: string }
  | { type: "cancel"; jobId: string }
  | { type: "dispose" };

export type FromWorker =
  | { type: "progress"; loaded: number; total: number }
  | { type: "ready" }
  | { type: "result"; jobId: string; text: string }
  | { type: "error"; jobId?: string; message: string };
