import { env, pipeline } from "@huggingface/transformers";
// The plain (non-asyncify) ONNX Runtime build: WASM only, 14 MB instead of 27 MB, and it compiles
// and runs faster. Vite serves both from /assets/ with a content hash, so they cache forever.
import ortMjsUrl from "onnxruntime-web/ort-wasm-simd-threaded.mjs?url";
import ortWasmUrl from "onnxruntime-web/ort-wasm-simd-threaded.wasm?url";
import type { SttModel } from "./models";
import type { FromWorker, LoadTimings, ToWorker } from "./protocol";

const SAMPLE_RATE = 16_000;
/** transformers.js keeps model files and the runtime here (Cache API). */
const CACHE_NAME = "transformers-cache";

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
const absolute = (url: string) => new URL(url, import.meta.url).href;
const now = () => Math.round(performance.now());

env.allowLocalModels = false;
env.useBrowserCache = true;
env.useWasmCache = true;

/** Responses already on their way, by URL, so a later fetch for the same file joins them. */
const early = new Map<string, Promise<Response>>();
/** Bytes of each model file read so far, for progress. */
const received = new Map<string, number>();
let onBytes: (() => void) | null = null;
const baseFetch = env.fetch;
env.fetch = async (input, init) => {
  const url = typeof input === "string" ? input : input.href;
  const pending = early.get(url);
  early.delete(url);
  if (!pending) return baseFetch(input, init);
  const response = await pending;
  if (!received.has(url) || !response.ok || !response.body) return response;
  // Count bytes as transformers.js reads the body, so progress is the real download.
  const reader = response.body.getReader();
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) return controller.close();
      received.set(url, received.get(url)! + value.byteLength);
      onBytes?.();
      controller.enqueue(value);
    },
    cancel: (reason) => reader.cancel(reason),
  });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
};

async function inCache(cache: Cache | null, url: string): Promise<boolean> {
  return !!(await cache?.match(url).catch(() => undefined));
}

function prefetch(url: string) {
  const response = baseFetch(url);
  response.catch(() => {}); // transformers.js reports the failure when it asks for the file.
  early.set(url, response);
}

/** Drops cached files of earlier versions (the old Hugging Face and jsDelivr URLs, ~80 MB). */
async function pruneCache(cache: Cache, keep: Set<string>) {
  for (const request of await cache.keys()) {
    if (!keep.has(request.url)) await cache.delete(request);
  }
}

let asrPromise: Promise<Asr> | null = null;

function load(model: SttModel): Promise<Asr> {
  asrPromise ??= (async () => {
    const t: LoadTimings = { start: now() };
    const cache = await caches.open(CACHE_NAME).catch(() => null);
    let progress: ((info: { status: string; loaded?: number; total?: number }) => void) | undefined;
    const keep = new Set<string>();

    if (model.hosted) {
      // Our own origin: no redirects, no CORS preflights, immutable caching. The folder name pins
      // the revision, so the template ignores {revision} (transformers.js also asks for "main").
      env.remoteHost = absolute("/models/");
      env.remotePathTemplate = `${model.hosted.dir}/`;
      const wasm = env.backends.onnx.wasm!;
      wasm.wasmPaths = { mjs: absolute(ortMjsUrl), wasm: absolute(ortWasmUrl) };

      // Start every download now and in parallel. transformers.js would fetch config.json first
      // and the runtime only after the first model file has arrived.
      const files = model.hosted.files.map((f) => ({ ...f, url: `${env.remoteHost}${env.remotePathTemplate}${f.path}` }));
      let total = 0;
      let cached = 0;
      for (const file of files) {
        total += file.size;
        keep.add(file.url);
        if (await inCache(cache, file.url)) cached += file.size;
        else {
          received.set(file.url, 0);
          prefetch(file.url);
        }
      }
      const runtimeUrl = absolute(ortWasmUrl);
      keep.add(runtimeUrl).add(absolute(ortMjsUrl));
      if (!(await inCache(cache, runtimeUrl))) prefetch(runtimeUrl);
      t.cached = cached === total;
      let last = -1;
      onBytes = () => {
        const loaded = Math.min(total, cached + [...received.values()].reduce((a, b) => a + b, 0));
        const step = Math.floor((loaded / total) * 100);
        if (step === last) return;
        last = step;
        post({ type: "progress", loaded, total });
      };
      onBytes();
    } else {
      progress = (info) => {
        if (info.status === "progress_total" && info.total) post({ type: "progress", loaded: info.loaded ?? 0, total: info.total });
      };
    }

    const asr = (await pipeline("automatic-speech-recognition", model.repo, {
      revision: model.revision,
      device: "wasm",
      dtype: model.dtype as never,
      progress_callback: progress,
    })) as unknown as Asr;
    t.sessions = now();
    onBytes = null;
    if (model.hosted) post({ type: "progress", loaded: 1, total: 1 });
    // Warm-up: the first run allocates buffers and prepares kernels. Half a second of quiet and a few
    // tokens (about 0.1 s) make the first real transcription as fast as the rest.
    await asr(new Float32Array(SAMPLE_RATE / 2), { max_new_tokens: 4 });
    t.ready = now();
    post({ type: "ready", timings: t });
    if (cache && keep.size) void pruneCache(cache, keep).catch(() => {});
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
