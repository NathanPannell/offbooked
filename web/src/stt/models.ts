// Model choices from docs/on-device-stt.md. Set VITE_STT_MODEL to switch, or "off" to disable.

export interface SttModel {
  id: string;
  repo: string;
  revision?: string;
  dtype: string | Record<string, string>;
  /** Approximate first download, for the data-saver opt-in. */
  downloadMb: number;
}

export const STT_MODELS: Record<string, SttModel> = {
  "moonshine-tiny": {
    id: "moonshine-tiny",
    repo: "onnx-community/moonshine-tiny-ONNX",
    revision: "a6da1241cd305dcd64eab1edbd615f2bb9aabb95",
    dtype: { encoder_model: "fp32", decoder_model_merged: "q8" },
    downloadMb: 55,
  },
  "whisper-tiny.en": {
    id: "whisper-tiny.en",
    repo: "onnx-community/whisper-tiny.en",
    dtype: "q8",
    downloadMb: 45,
  },
};

export const DEFAULT_STT_MODEL = "moonshine-tiny";

export function configuredModel(): SttModel | null {
  const id = import.meta.env.VITE_STT_MODEL || DEFAULT_STT_MODEL;
  if (id === "off") return null;
  return STT_MODELS[id] ?? STT_MODELS[DEFAULT_STT_MODEL];
}
