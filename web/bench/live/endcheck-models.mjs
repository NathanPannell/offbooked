// Browser module for whisper-endcheck.mjs, served by the Vite dev server (not part of the app).
// Loads both models on the page's main thread, one WASM thread each, so a CPU throttle slows them
// alike: Moonshine Tiny as the app ships it, transcribing as a live pass does, and Whisper tiny.en q8
// scoring the line teacher-forced (the line as the decoder's input, "did they say these words?").
import { AutoProcessor, AutoTokenizer, env, pipeline, Tensor, WhisperForConditionalGeneration } from "@huggingface/transformers";
import ortMjsUrl from "onnxruntime-web/ort-wasm-simd-threaded.mjs?url";
import ortWasmUrl from "onnxruntime-web/ort-wasm-simd-threaded.wasm?url";
import hosted from "/src/stt/hosted-model.json";

const absolute = (url) => new URL(url, globalThis.location.href).href;
env.allowLocalModels = false;
env.backends.onnx.wasm.wasmPaths = { mjs: absolute(ortMjsUrl), wasm: absolute(ortWasmUrl) };
env.backends.onnx.wasm.numThreads = 1;

const WHISPER = "onnx-community/whisper-tiny.en";

export async function loadMoonshine() {
  const { remoteHost, remotePathTemplate } = env;
  env.remoteHost = absolute("/models/");
  env.remotePathTemplate = `${hosted.dir}/`;
  try {
    const asr = await pipeline("automatic-speech-recognition", hosted.repo, {
      revision: hosted.revision,
      device: "wasm",
      dtype: { encoder_model: "fp16", decoder_model_merged: "q8" },
    });
    await asr(new Float32Array(8000), { max_new_tokens: 4 });
    return async (audio) => {
      const out = await asr(audio, { max_new_tokens: Math.max(8, Math.ceil((audio.length / 16000) * 6)) });
      return (Array.isArray(out) ? out[0] : out).text.trim();
    };
  } finally {
    env.remoteHost = remoteHost;
    env.remotePathTemplate = remotePathTemplate;
  }
}

const logSoftmaxAt = (row, id) => {
  let max = -Infinity;
  for (const v of row) if (v > max) max = v;
  let sum = 0;
  for (const v of row) sum += Math.exp(v - max);
  return row[id] - max - Math.log(sum);
};

export async function loadWhisper() {
  const model = await WhisperForConditionalGeneration.from_pretrained(WHISPER, { dtype: "q8" });
  const processor = await AutoProcessor.from_pretrained(WHISPER);
  const tokenizer = await AutoTokenizer.from_pretrained(WHISPER);
  const prefix = tokenizer.encode("<|startoftranscript|><|notimestamps|>", { add_special_tokens: false });
  const eot = tokenizer.encode("<|endoftext|>", { add_special_tokens: false })[0];
  /**
   * One decoder pass with the whole line as its input. hyp[k] is the log-probability of "the first
   * k words of the line, then end of text"; saidWords is the most likely k.
   */
  return async (audio, text) => {
    const { input_features } = await processor(audio);
    const words = text.trim().split(/\s+/);
    const wordTokens = words.map((w) => tokenizer.encode(" " + w, { add_special_tokens: false }));
    const ids = [...prefix, ...wordTokens.flat()];
    const decoder_input_ids = new Tensor("int64", BigInt64Array.from(ids.map(BigInt)), [1, ids.length]);
    const { logits } = await model({ input_features, decoder_input_ids });
    const V = logits.dims[2];
    const row = (pos) => logits.data.subarray(pos * V, (pos + 1) * V);
    const hyp = [];
    let pos = prefix.length - 1; // the logits at pos predict token pos + 1
    let acc = 0;
    for (const toks of wordTokens) {
      hyp.push(acc + logSoftmaxAt(row(pos), eot));
      for (const id of toks) acc += logSoftmaxAt(row(pos++), id);
    }
    hyp.push(acc + logSoftmaxAt(row(pos), eot));
    let saidWords = 0;
    for (let k = 1; k <= words.length; k++) if (hyp[k] > hyp[saidWords]) saidWords = k;
    return { words: words.length, saidWords, hyp };
  };
}
