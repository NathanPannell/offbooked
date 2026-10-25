import { access } from "node:fs/promises";
import type { Log } from "../log.ts";
import { PriorityPool, TTS_PRIORITY } from "../tts/service.ts";
import { VOCAB_SIZE, type Emissions } from "./ctc.ts";

// The speech model the aligner reads letters from (ctc.ts): wav2vec2-base-960h, a CTC model over
// English letters trained on LibriSpeech, as ONNX with its matrix products in 4 bits (90 MB; the
// full-precision model is 378 MB and aligns the fixtures the same), run on the CPU by ONNX Runtime.
// Pinned by revision and SHA-256 in the Dockerfile, at ALIGN_MODEL. Without the file (Windows dev,
// tests) the aligner says so once and takes are cut by loudness.
//
// It runs one take at a time (a PriorityPool of 1: a line someone is waiting to hear goes before the
// upload queue), on 10 s windows overlapping by 2 s, so a long take never needs attention over
// minutes of audio. The model is loaded on first use and let go after a minute idle: the server
// grows by about 300 MB while it is loaded (about 480 MB aligning a 50 s speech), and nothing
// runs while nobody records or listens.

export const MODEL = {
  rate: 16_000,
  hop: 320, // samples per output frame (20 ms)
  windowS: 10, // 20 s windows align the same and take half again as much memory on a long take
  overlapS: 2,
  idleMs: 60_000,
} as const;

/** Letter probabilities for 16 kHz mono speech (see ctc.ts), or null when the model isn't there. */
export interface Aligner {
  emissions(pcm: Int16Array, priority?: number): Promise<Emissions | null>;
  close(): Promise<void>;
}

/** The part of an ONNX Runtime session this uses (tests pass a fake). */
export interface ModelSession {
  run(input: Float32Array): Promise<{ data: Float32Array; frames: number; vocab: number }>;
  release(): Promise<void>;
}

export type LoadSession = (modelPath: string, threads: number) => Promise<ModelSession>;

/** ONNX Runtime, loaded only when a take is first aligned (it is about 30 MB of native code). */
export const loadOnnxSession: LoadSession = async (modelPath, threads) => {
  // ONNX Runtime would otherwise try to send usage telemetry; read by the library as it loads.
  process.env.ORT_DISABLE_TELEMETRY ??= "1";
  const ort = (await import("onnxruntime-node")).default;
  const session = await ort.InferenceSession.create(modelPath, {
    intraOpNumThreads: threads,
    interOpNumThreads: 1,
    executionMode: "sequential",
    graphOptimizationLevel: "all",
  });
  const [input] = session.inputNames;
  const [output] = session.outputNames;
  return {
    async run(x) {
      const result = await session.run({ [input!]: new ort.Tensor("float32", x, [1, x.length]) });
      const t = result[output!]!;
      return { data: t.data as Float32Array, frames: t.dims[1]!, vocab: t.dims[2]! };
    },
    release: () => session.release(),
  };
};

/** One window of samples scaled as the model was trained: zero mean, unit variance. */
export function scaled(pcm: Int16Array, from: number, to: number): Float32Array {
  const n = to - from;
  let mean = 0;
  for (let i = from; i < to; i++) mean += pcm[i]!;
  mean /= n;
  let v = 0;
  for (let i = from; i < to; i++) v += (pcm[i]! - mean) ** 2;
  const sd = Math.sqrt(v / n + 1e-7);
  const x = new Float32Array(n);
  for (let i = from; i < to; i++) x[i - from] = (pcm[i]! - mean) / sd;
  return x;
}

/** Log-softmax of one frame of logits, written into `out` at `at`. */
function logSoftmax(logits: Float32Array, row: number, vocab: number, out: Float32Array, at: number) {
  let m = -Infinity;
  for (let k = 0; k < vocab; k++) m = Math.max(m, logits[row * vocab + k]!);
  let sum = 0;
  for (let k = 0; k < vocab; k++) sum += Math.exp(logits[row * vocab + k]! - m);
  const z = Math.log(sum) + m;
  for (let k = 0; k < vocab; k++) out[at + k] = logits[row * vocab + k]! - z;
}

/**
 * The model run over the whole take, window by window: each frame is taken from the window where it
 * has at least a second of audio on both sides (except at the take's two ends).
 */
export async function windowedEmissions(session: ModelSession, pcm: Int16Array): Promise<Emissions | null> {
  const win = MODEL.windowS * MODEL.rate;
  const hop = (MODEL.windowS - MODEL.overlapS) * MODEL.rate;
  const keep = (MODEL.overlapS / 2) * (MODEL.rate / MODEL.hop); // frames of context kept on each side
  const total = Math.floor(pcm.length / MODEL.hop);
  if (total < 2) return null;
  const logp = new Float32Array(total * VOCAB_SIZE);
  let filled = 0;
  for (let from = 0; from < pcm.length && filled < total; from += hop) {
    const to = Math.min(pcm.length, from + win);
    if (to - from < MODEL.hop * 2) break;
    const out = await session.run(scaled(pcm, from, to));
    if (out.vocab !== VOCAB_SIZE) throw new Error(`aligner model has ${out.vocab} tokens, expected ${VOCAB_SIZE}`);
    const first = from / MODEL.hop;
    const last = to === pcm.length ? out.frames : Math.min(out.frames, hop / MODEL.hop + keep);
    for (let f = Math.max(0, filled - first); f < last && first + f < total; f++) logSoftmax(out.data, f, out.vocab, logp, (first + f) * VOCAB_SIZE);
    filled = Math.min(total, first + last);
    if (to === pcm.length) break;
  }
  return { frames: filled, vocab: VOCAB_SIZE, logp: logp.subarray(0, filled * VOCAB_SIZE) };
}

export class ModelAligner implements Aligner {
  private session: Promise<ModelSession> | null = null;
  private idle: NodeJS.Timeout | null = null;
  private missing: boolean | null = null;
  private readonly pool = new PriorityPool(1);
  private readonly modelPath: string;
  private readonly threads: number;
  private readonly log: Log;
  private readonly load: LoadSession;
  private readonly idleMs: number;

  constructor(opts: { modelPath: string; threads: number; log: Log; load?: LoadSession; idleMs?: number }) {
    this.modelPath = opts.modelPath;
    this.threads = opts.threads;
    this.log = opts.log;
    this.load = opts.load ?? loadOnnxSession;
    this.idleMs = opts.idleMs ?? MODEL.idleMs;
  }

  async emissions(pcm: Int16Array, priority: number = TTS_PRIORITY.render): Promise<Emissions | null> {
    if (this.missing === null) {
      this.missing = !(await access(this.modelPath).then(
        () => true,
        () => false,
      ));
      if (this.missing) this.log.warn({ modelPath: this.modelPath }, "speech aligner model not found: takes are cut by loudness, without word timings");
    }
    if (this.missing) return null;
    return this.pool.use(this.pool.ticket(priority), async () => {
      if (this.idle) clearTimeout(this.idle);
      this.idle = null;
      this.session ??= this.load(this.modelPath, this.threads);
      try {
        return await windowedEmissions(await this.session, pcm);
      } catch (err) {
        // A session that failed to load is tried again next time.
        await this.drop();
        throw err;
      } finally {
        this.releaseWhenIdle();
      }
    });
  }

  /** Lets the model go after a while unused (a timer, never a query: nothing runs while idle). */
  private releaseWhenIdle(): void {
    if (!this.session) return;
    this.idle = setTimeout(() => void this.drop(), this.idleMs);
    this.idle.unref();
  }

  private async drop(): Promise<void> {
    if (this.idle) clearTimeout(this.idle);
    this.idle = null;
    const session = this.session;
    this.session = null;
    if (session) await session.then((s) => s.release()).catch(() => undefined);
  }

  close(): Promise<void> {
    return this.drop();
  }
}
