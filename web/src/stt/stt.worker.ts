import { env, pipeline } from "@huggingface/transformers";
import type { SttModel } from "./models";
import type { FromWorker, ToWorker } from "./protocol";

const SAMPLE_RATE = 16_000;

interface Asr {
  (audio: Float32Array, options?: Record<string, unknown>): Promise<{ text: string } | { text: string }[]>;
  tokenizer: { encode(text: string): number[] };
  dispose(): Promise<void>;
}

const scope = self as unknown as {
  postMessage(message: FromWorker): void;
  onmessage: ((event: MessageEvent<ToWorker>) => void) | null;
  close(): void;
};
const post = (message: FromWorker) => scope.postMessage(message);

env.allowLocalModels = false;
env.useBrowserCache = true;
env.useWasmCache = true;
// Low fetch priority so model bytes don't starve take uploads.
const baseFetch = env.fetch;
env.fetch = (input, init) => baseFetch(input, { ...init, priority: "low" });

let asrPromise: Promise<Asr> | null = null;

function load(model: SttModel): Promise<Asr> {
  asrPromise ??= (async () => {
    const asr = (await pipeline("automatic-speech-recognition", model.repo, {
      revision: model.revision,
      device: "wasm",
      dtype: model.dtype as never,
      progress_callback: (info: { status: string; loaded?: number; total?: number }) => {
        if (info.status === "progress_total" && info.total) {
          post({ type: "progress", loaded: info.loaded ?? 0, total: info.total });
        }
      },
    })) as unknown as Asr;
    await asr(new Float32Array(SAMPLE_RATE)); // Warm-up: JIT and allocations.
    post({ type: "ready" });
    return asr;
  })();
  return asrPromise;
}

const queue: Extract<ToWorker, { type: "transcribe" }>[] = [];
const cancelled = new Set<string>();
let running = false;

// One inference at a time: a pipeline can't run two at once.
async function pump() {
  if (running || !asrPromise) return;
  running = true;
  try {
    const asr = await asrPromise;
    while (queue.length) {
      const job = queue.shift()!;
      if (cancelled.delete(job.jobId)) continue;
      try {
        const seconds = job.audio.length / SAMPLE_RATE;
        // Moonshine's default budget is floor(seconds) * 6 tokens: nothing at all under one second.
        const expectedTokens = asr.tokenizer.encode(job.expected).length;
        const maxNewTokens = Math.max(8, Math.ceil(seconds * 6), Math.ceil(expectedTokens * 1.3) + 4);
        const out = await asr(job.audio, { max_new_tokens: maxNewTokens });
        const text = (Array.isArray(out) ? out[0] : out).text.trim();
        post({ type: "result", jobId: job.jobId, text });
      } catch (err) {
        post({ type: "error", jobId: job.jobId, message: String(err) });
      }
    }
  } catch (err) {
    post({ type: "error", message: String(err) });
  } finally {
    running = false;
  }
}

scope.onmessage = async (event) => {
  const message = event.data;
  if (message.type === "load") {
    load(message.model).then(
      () => void pump(),
      (err) => post({ type: "error", message: String(err) }),
    );
  } else if (message.type === "transcribe") {
    queue.push(message);
    void pump();
  } else if (message.type === "cancel") {
    if (queue.some((job) => job.jobId === message.jobId)) cancelled.add(message.jobId);
  } else if (message.type === "dispose") {
    queue.length = 0;
    const asr = await asrPromise?.catch(() => null);
    await asr?.dispose().catch(() => {});
    scope.close();
  }
};
