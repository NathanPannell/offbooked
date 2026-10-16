// Model choices from docs/on-device-stt.md. Set VITE_STT_MODEL to switch, or "off" to disable.
import hosted from "./hosted-model.json";

export interface SttModel {
  id: string;
  repo: string;
  revision?: string;
  dtype: string | Record<string, string>;
  /** Approximate first download, for the data-saver opt-in. */
  downloadMb: number;
  /**
   * Served from our own origin under /models/<dir>/ (scripts/fetch-stt-model.mjs) instead of the
   * Hugging Face hub. `files` are the paths the worker loads, with their sizes for download progress.
   */
  hosted?: { dir: string; files: { path: string; size: number }[] };
}

// fp16 encoder: half the bytes of fp32 with the same accuracy (q8 lost 3 points of WER on noisy takes).
const MOONSHINE_DTYPE = { encoder_model: "fp16", decoder_model_merged: "q8" };

/** About what the ONNX Runtime WASM binary costs over the wire (14 MB, compressed by the CDN). */
const RUNTIME_MB = 3;

/** The ONNX files transformers.js loads for a dtype mix: `q8` is the `_quantized` file. */
function onnxFiles(dtype: Record<string, string>): string[] {
  const suffix: Record<string, string> = { fp32: "", q8: "_quantized", fp16: "_fp16", q4: "_q4" };
  return Object.entries(dtype).map(([name, d]) => `onnx/${name}${suffix[d] ?? `_${d}`}.onnx`);
}

export function hostedFiles(dtype: Record<string, string>) {
  const wanted = new Set(["config.json", "generation_config.json", "preprocessor_config.json", "tokenizer.json", "tokenizer_config.json", ...onnxFiles(dtype)]);
  // A file missing from hosted-model.json fails the model load (and the models test), not the page.
  return hosted.files.filter((f) => wanted.has(f.path)).map(({ path, size }) => ({ path, size }));
}

const moonshineFiles = hostedFiles(MOONSHINE_DTYPE);

export const STT_MODELS: Record<string, SttModel> = {
  "moonshine-tiny": {
    id: "moonshine-tiny",
    repo: hosted.repo,
    revision: hosted.revision,
    dtype: MOONSHINE_DTYPE,
    downloadMb: Math.round(moonshineFiles.reduce((sum, f) => sum + f.size, 0) / 1e6) + RUNTIME_MB,
    hosted: { dir: hosted.dir, files: moonshineFiles },
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
