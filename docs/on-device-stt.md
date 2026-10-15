# On-device speech-to-text for take scoring

Status: research and recommendation, 2026-10-13. Nothing here is implemented yet.

## Goal

After each take, transcribe the recording on the actor's own device and compare it with the known script line. From that comparison we show:

- per-line word accuracy, with missed, substituted and extra words highlighted
- a "drifted from the script" flag that suggests a re-record
- an accuracy summary at the end of recording and after a "my part" run-through practice

Constraints:

- Mobile first: iOS Safari and Android Chrome, plus desktop.
- Takes are 1–30 s MediaRecorder blobs. Chrome records webm/opus and Safari records mp4/aac.
- English only for the MVP.
- The actor must reach the first recorded line within two minutes. Model download is lazy, starts in the background after the first take, and never blocks recording.
- The app is Vite + React + TypeScript and is hosted on Vercel at offbooked.com. The API is at api.offbooked.com, and audio goes to R2.

## Recommendation in one paragraph

Use **transformers.js** (`@huggingface/transformers@4.3.1`, pinned exactly) in a module Web Worker. Run **Moonshine Tiny** (`onnx-community/moonshine-tiny-ONNX`, MIT) on the **WASM backend**, with an fp32 encoder and a q8 merged decoder. The download is about 55 MB of model files plus the ONNX Runtime WASM binary. Both are cached in the Cache API after the first load. Decode each MediaRecorder blob on the main thread with an `OfflineAudioContext` at 16 kHz. Then transfer the `Float32Array` to the worker and score the transcript with a normalized word-level Levenshtein alignment that tolerates near-misses. **Do not enable COOP/COEP for the MVP**: single-threaded WASM is fast enough for Moonshine Tiny on clips this short, and cross-origin isolation would constrain our audio and third-party embeds. Do not use the Web Speech API as the main path. It cannot transcribe a recorded blob, and on Android and iOS it is not on-device.

## Options compared

Latency figures are for a 10-second clip on a mid-range 2023–2024 phone (for example Pixel 7a, Galaxy A54 or iPhone 12/13) with the model already loaded and no cross-origin isolation (one WASM thread). **They are estimates**, derived from published desktop timings, model FLOPs (Moonshine needs about 5× less compute than Whisper tiny for a 10 s clip, because Whisper always encodes a padded 30 s window) and parameter counts. No credible public phone benchmark exists for these exact setups. Spike step 1 below measures them on real devices.

WER is on LibriSpeech test-clean (read speech), from the model authors. Expect a few points worse for phone recordings of expressive theatrical delivery.

| Option | On-device? | Download (first use) | iOS Safari | Est. latency, 10 s clip | WER, read speech | Licence | Maturity |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **transformers.js + Moonshine Tiny** (`onnx-community/moonshine-tiny-ONNX`) | Yes, in every browser | ~55 MB model (fp32 encoder 30.9 MB + q8 decoder 20.2 MB + 3.9 MB tokenizer and config), plus the ORT WASM binary (14–27 MB uncompressed, much less over the wire). An all-q8 variant is ~32 MB. | Works on WASM (needs WASM SIMD, so iOS 16.4+). WebGPU on iOS 26+ (enabled in transformers.js 4.3.0). | ~1–2 s | 4.5% (Whisper tiny.en 5.7%) | Library Apache-2.0, ORT MIT, model MIT | Library: high (HF-maintained, v4.3.1 released 2026-10-06). Model: stable since Jan 2025; a token-decoding fix landed in 4.3.0. |
| transformers.js + Moonshine Base (`onnx-community/moonshine-base-ONNX`) | Yes | ~63 MB all q8, ~123 MB with fp32 encoder | As above. Memory is fine; the download is heavy on cellular. | ~2–5 s | 3.2% | MIT | As above |
| transformers.js + Whisper tiny.en (`onnx-community/whisper-tiny.en`) | Yes | ~41 MB q8 (encoder 10.1 MB + merged decoder 30.7 MB) + ~4 MB tokenizer; fp32 encoder + q4 decoder ≈ 120 MB | Works on WASM; WebGPU on iOS 26+ | ~4–8 s (fixed 30 s encoder window, whatever the clip length) | 5.7% | MIT | Very mature. Prone to hallucinating on silence ("Thank you."). |
| transformers.js + Whisper base.en | Yes | ~77 MB q8 | Works, but slow on one thread | ~8–15 s | 4.3% | MIT | Mature |
| Parakeet (`onnx-community/parakeet-ctc-0.6b-ONNX`, TDT 0.6B) | Yes | 600 MB+ even quantized | Impractical | n/a on phones | ~1.7–2% | CC-BY-4.0 | Supported in transformers.js v4, but desktop/WebGPU only in practice |
| **Web Speech API**, Chrome desktop 139+ with `processLocally = true` | Yes, once the language pack is installed via `SpeechRecognition.install()`. `available()` reports status. `phrases` contextual biasing since Chrome 142. | Language pack downloaded by Chrome, not us | Not applicable | Live; final result about 0.3–1 s after speech ends | Good (no published WER) | Browser built-in | Experimental, desktop only (MDN data: not on Chrome Android) |
| Web Speech API, Chrome Android | **No**. Audio goes to Google's recognition service. `processLocally`, `available()`, `install()` and `phrases` are not supported. `continuous` has no effect. | None | n/a | Live | Good (server) | n/a | Stable but server-side |
| Web Speech API, iOS/macOS Safari (`webkitSpeechRecognition`) | **Not controllable**. It uses Apple's speech service, which may be server-side. A page cannot require on-device processing. Siri and Dictation must be enabled. | None | Yes, but no on-device guarantee | Live | Good | n/a | Quirky (interim and final-result behaviour has changed between versions) |
| vosk-browser (Kaldi WASM) + `vosk-model-small-en-us-0.15` | Yes | ~40 MB tar.gz model + ~5 MB WASM | Works (single-threaded, no COOP/COEP) | ~1–2 s | 9.9% | Apache-2.0 | Low: npm `vosk-browser@0.0.8` last published Dec 2022; one maintainer; 29 open issues |
| sherpa-onnx WASM (streaming Zipformer English) | Yes | ~20–70 MB model, packed into an Emscripten `.data` file at build time | Risky: the demo builds set `INITIAL_MEMORY=512MB` | ~1–2 s | ~3–7% depending on model | Apache-2.0 | Core project active (v1.13.8, Sep 2026), but there is no browser npm package. You compile it with Emscripten yourself. |
| whisper.cpp WASM | Yes | tiny.en ggml: 75 MB (q5_1 ~31 MB, q8_0 ~42 MB) | Needs SharedArrayBuffer, so COOP/COEP is **mandatory** (iOS 15.2+) | ~3–6 s with threads; much slower without | 5.7% (tiny.en) | MIT | Core mature; the WASM build is an example, not a supported package |
| Moonshine v2 streaming (`moonshine-ai/moonshine-streaming-tiny`, 34M) | Not yet in a browser runtime | n/a | n/a | n/a | Not comparable (Open ASR average ~12%) | MIT | New. transformers.js has no `moonshine_streaming` architecture yet; only community ONNX exports and GGUF ports exist. Re-check in 2027. |

### How each option uses the known script

- **Web Speech `phrases`** (Chrome desktop 142+, on-device only) boosts expected phrases. It does not exist on mobile.
- **vosk grammar**: `new model.KaldiRecognizer(16000, JSON.stringify([...lineWords, "[unk]"]))` restricts the decoder to the expected words. This makes recognition of rare script words (names, archaic words) very robust. The catch is that an off-script word can only come out as `[unk]` or as a wrong in-grammar word. Substitutions are still detectable, but you cannot show the word the actor actually said. Grammar mode works only with the small models.
- **sherpa-onnx hotwords** (`modified_beam_search` with a hotwords file and score) give true contextual biasing for transducer models. Hotwords have to be written into the Emscripten virtual filesystem, so this needs our own WASM build.
- **whisper.cpp** has a GBNF grammar and initial prompt in its CLI. Neither is exposed in the WASM example.
- **Whisper or Moonshine in transformers.js** have no grammar. A Whisper prompt with the expected line could be built at a low level, but we do not want that (see below).

**Biasing is a double-edged sword for us.** The product's job is to catch the actor drifting from the script. A recognizer pushed hard towards the expected line will "hear" the line even when the actor paraphrased it, which hides exactly the errors we want to flag. We get the benefit without that risk by doing unbiased recognition and **tolerant scoring**: normalization, contraction and number canonicalization, compound merging, and near-match acceptance for long words. That last step absorbs the main real failure mode, which is ASR misspelling names and rare words such as Petruchio becoming "Petrucio". We use the known text in two safe ways: it sets the decoder's token budget (see the worker section), and it drives the alignment.

## Why the alternatives lost

- **Web Speech API**: it cannot take a recorded blob, only live microphone input. `start(MediaStreamTrack)` exists only as an experimental prototype. It is not on-device on Android or iOS, which is two of our three platforms. On phones it also fights MediaRecorder for the microphone. It is worth revisiting only as an optional desktop extra for live "my part" practice feedback (`processLocally` plus `phrases`).
- **Whisper tiny.en**: about 3× slower than Moonshine Tiny on short clips (fixed 30 s window), slightly less accurate, and it hallucinates on silence and near-silence. It is a fine fallback if Moonshine misbehaves on our audio in the spike, because the same code serves both. Only the model ID and dtype change.
- **Moonshine Base**: better accuracy, but 63–123 MB is a lot to pull over cellular in the background, and it is 2–3× slower. Revisit if the spike shows Tiny produces too many false "check" flags.
- **vosk-browser**: effectively unmaintained, with lower accuracy in free mode. Grammar mode is attractive but hides what was actually said.
- **sherpa-onnx**: technically strong (hotwords, small streaming models), but it means owning an Emscripten build pipeline, a 512 MB initial heap that risks iOS tab kills, and model files baked into `.data` bundles. That cost is too high for an MVP.
- **whisper.cpp WASM**: requires COOP/COEP, is slow without threads, and has no maintained package.

## Implementation plan

### Overview

```text
 main thread                                   stt.worker.ts (module worker)
 ───────────                                   ──────────────────────────────
 MediaRecorder → Blob ─┐
                       ├─ upload (existing flow, unchanged)
                       └─ decodeTo16kMono(blob)  ── postMessage({takeId, audio, expected}, [audio.buffer]) ──▶ queue
                                                                                                             │
                                                 lazy: pipeline('automatic-speech-recognition', moonshine) ◀─┘
                                                                                                             │
 scoreTake(expected, text) ◀── postMessage({takeId, text}) ◀───────────────────────────────── transcriber(audio)
 → per-line badge, summary
```

Files (suggested):

- `web/src/stt/stt.worker.ts`: loads the model and transcribes a queue of jobs one at a time.
- `web/src/stt/sttClient.ts`: owns the worker, does capability checks, the lazy start and the job queue on the main thread, and exposes a small subscribe API for React.
- `web/src/stt/decodeAudio.ts`: turns a blob into 16 kHz mono Float32, plus trim, normalize and silence detection.
- `web/src/stt/score.ts`: normalization, alignment, accuracy and verdict. Pure and unit tested.
- `web/src/stt/useTakeScore.ts`: React hook.

### Dependencies

```bash
npm i -E @huggingface/transformers@4.3.1 wasm-feature-detect@1.9.0
```

- Pin exactly. 4.3.1 depends on a dev build of ONNX Runtime Web (`onnxruntime-web@1.31.0-dev.20260914-8d85527a0`). 4.3.0 is the minimum, because it fixed Moonshine token decoding and enabled WebGPU on Safari 26+.
- The package also pulls `sharp` and `onnxruntime-node` as dependencies. They are only used in Node and do not end up in the browser bundle, but they make `npm install` heavier.
- Vite: use a module worker (`new Worker(new URL('./stt.worker.ts', import.meta.url), { type: 'module' })`) and set `worker: { format: 'es' }`. If dev-server prebundling causes trouble, add `optimizeDeps: { exclude: ['@huggingface/transformers'] }`. Because transformers.js is imported only by the worker, Vite code-splits it out of the main bundle, so it costs the first screen nothing.

### Capability check and graceful fallback

Run this before starting the worker. If any check fails, scoring is off for the session and every take shows **"Accuracy unavailable"**. This is neutral grey, not an error, and it never blocks recording or upload.

```ts
// sttClient.ts
import { simd } from 'wasm-feature-detect';

export async function canRunStt(): Promise<boolean> {
  try {
    if (typeof Worker === 'undefined' || typeof WebAssembly === 'undefined') return false;
    if (typeof OfflineAudioContext === 'undefined') return false;
    if (!('caches' in self)) return false;               // model would re-download every time
    if (!(await simd())) return false;                   // ORT Web ships SIMD builds only (iOS < 16.4 fails here)
    const mem = (navigator as any).deviceMemory as number | undefined; // Chromium only
    if (mem !== undefined && mem < 2) return false;
    const est = await navigator.storage?.estimate?.();
    if (est?.quota !== undefined && est.quota - (est.usage ?? 0) < 200e6) return false;
    return true;
  } catch {
    return false;
  }
}
```

Also fall back at run time. If the worker posts an `error` (a model fetch fails after retries, or session creation fails or runs out of memory), or the worker dies (`worker.onerror`), mark all pending and future takes in this session as "Accuracy unavailable" and terminate the worker. Do not retry in a loop. On `navigator.connection?.saveData === true`, do not auto-download. Show a small "Turn on accuracy check (55 MB download)" toggle instead.

### Lazy loading after the first take

1. On the recording page, start the model 1.5 s after the page opens, at low fetch priority (changed 2026-10-15 so live word highlighting is ready a line or two in). Recording never waits for it.
2. Then call `sttClient.start()`. It runs `canRunStt()`, creates the worker and sends `{ type: 'load' }`. The worker starts downloading the model at low fetch priority (see `env.fetch` below), so take uploads keep their bandwidth.
3. Takes recorded while the model is loading are queued, including take 1. Decoded audio is small (30 s × 16 000 × 4 B ≈ 1.9 MB), so keep the `Float32Array`s in the worker queue and score them in order once the model is ready.
4. UI: a small status chip on the recording screen shows "Accuracy check: preparing (37%)", then "ready". Per-line badges fill in as results arrive. Nothing waits on them.
5. When a line is re-recorded, send `{ type: 'cancel', takeId }` for the superseded take so the queue doesn't waste time on it.
6. When the actor leaves the recording or practice screens, call `transcriber.dispose()` and terminate the worker. That frees roughly 200–300 MB, which matters on iOS. The model stays in the Cache API, so the next load takes seconds.

### The worker

```ts
// web/src/stt/stt.worker.ts
import { pipeline, env } from '@huggingface/transformers';

const MODEL_ID = 'onnx-community/moonshine-tiny-ONNX';
const REVISION = 'a6da1241cd305dcd64eab1edbd615f2bb9aabb95'; // pin: current main as of 2026-10-13
const SAMPLE_RATE = 16_000;

env.allowLocalModels = false;  // never probe /models/ on our origin
env.useBrowserCache = true;    // Cache API ("transformers-cache"); default true where available
env.useWasmCache = true;       // cache the ORT .wasm/.mjs too (v4)
// Low priority so model bytes don't starve take uploads (Fetch Priority: Chrome 101+, Safari 17.2+; ignored elsewhere).
const baseFetch = env.fetch;
env.fetch = (url: RequestInfo | URL, init?: RequestInit) =>
  baseFetch(url, { ...init, priority: 'low' } as RequestInit);
// Optional self-hosting, see "Caching and hosting":
// env.remoteHost = 'https://offbooked.com/models/';
// env.remotePathTemplate = '{model}/{revision}/';
// env.backends.onnx.wasm!.wasmPaths = { mjs: '/ort/ort-wasm-simd-threaded.mjs', wasm: '/ort/ort-wasm-simd-threaded.wasm' };

type Asr = (audio: Float32Array, opts?: Record<string, unknown>) => Promise<{ text: string } | { text: string }[]>;
let asrPromise: Promise<Asr & { tokenizer: any; dispose(): Promise<void> }> | null = null;

function load() {
  asrPromise ??= (pipeline('automatic-speech-recognition', MODEL_ID, {
    revision: REVISION,
    device: 'wasm',
    dtype: { encoder_model: 'fp32', decoder_model_merged: 'q8' },
    progress_callback: (p: unknown) => postMessage({ type: 'progress', p }),
  }) as any).then(async (asr: any) => {
    await asr(new Float32Array(SAMPLE_RATE)); // warm-up run (JIT, allocations)
    postMessage({ type: 'ready' });
    return asr;
  });
  return asrPromise!;
}

type Job = { takeId: string; audio: Float32Array; expected: string };
const queue: Job[] = [];
const cancelled = new Set<string>();
let running = false;

async function pump() {
  if (running) return;
  running = true;
  try {
    const asr = await load();
    while (queue.length) {
      const job = queue.shift()!;
      if (cancelled.delete(job.takeId)) continue;
      const seconds = job.audio.length / SAMPLE_RATE;
      // Moonshine's pipeline defaults to floor(seconds) * 6 tokens: 0 tokens for a 0.8 s "Yes!".
      // Use the known line to set a safe budget instead.
      const expectedTokens = asr.tokenizer.encode(job.expected).length;
      const max_new_tokens = Math.max(8, Math.ceil(seconds * 6), Math.ceil(expectedTokens * 1.3) + 4);
      const out = await asr(job.audio, { max_new_tokens });
      const text = (Array.isArray(out) ? out[0] : out).text.trim();
      postMessage({ type: 'result', takeId: job.takeId, text });
    }
  } catch (err) {
    postMessage({ type: 'error', message: String(err) });
  } finally {
    running = false;
  }
}

self.onmessage = async (e: MessageEvent) => {
  const msg = e.data;
  if (msg.type === 'load') void load().catch((err) => postMessage({ type: 'error', message: String(err) }));
  if (msg.type === 'transcribe') { queue.push(msg as Job); void pump(); }
  if (msg.type === 'cancel') cancelled.add(msg.takeId);
  if (msg.type === 'dispose') { const a = await asrPromise; await a?.dispose(); close(); }
};
```

Notes:

- transformers.js cannot run two inferences at once on one pipeline. The single-consumer queue above serializes them.
- The pipeline accepts a `Float32Array` and assumes it is already at the model's sampling rate (16 kHz). It does not resample.
- Moonshine handles up to about 30 s per call. Takes longer than 28 s should be split at the quietest point near the middle, using the same RMS frames as the trim step. Transcribe the parts and join the text with a space.
- Use `device: 'wasm'` everywhere for the MVP. WebGPU (Chrome Android 121+, Safari 26+, Chrome desktop) is a later optimization behind a flag. It would use `dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' }`, because int8 ops are poorly supported on WebGPU, and it adds shader compile time and per-GPU driver risk. For 1–30 s clips on a 27M-parameter model, WASM is fast enough.
- Without cross-origin isolation, ONNX Runtime Web runs WASM on one thread. That is expected (see Headers).

### Decoding MediaRecorder blobs to 16 kHz mono Float32

`AudioContext` and `OfflineAudioContext` do not exist in workers, so decode on the main thread. Then transfer the buffer, which makes it zero-copy.

```ts
// web/src/stt/decodeAudio.ts
const TARGET_RATE = 16_000;

export async function decodeTo16kMono(blob: Blob): Promise<Float32Array> {
  const bytes = await blob.arrayBuffer();
  let buf: AudioBuffer;
  try {
    // decodeAudioData resamples to the context's rate, so a 16 kHz offline context gives 16 kHz output directly.
    buf = await new OfflineAudioContext(1, 1, TARGET_RATE).decodeAudioData(bytes.slice(0));
  } catch {
    // Fallback: decode at the device rate, then resample by rendering.
    const ac = new AudioContext();
    try { buf = await ac.decodeAudioData(bytes); } finally { void ac.close(); }
  }
  if (buf.sampleRate !== TARGET_RATE) buf = await resample(buf, TARGET_RATE);
  return toMono(buf);
}

async function resample(buf: AudioBuffer, rate: number): Promise<AudioBuffer> {
  const ctx = new OfflineAudioContext(1, Math.ceil(buf.duration * rate), rate);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination); // 1-channel destination downmixes
  src.start();
  return ctx.startRendering();
}

function toMono(buf: AudioBuffer): Float32Array {
  if (buf.numberOfChannels === 1) return buf.getChannelData(0).slice();
  const out = new Float32Array(buf.length);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const ch = buf.getChannelData(c);
    for (let i = 0; i < out.length; i++) out[i] += ch[i] / buf.numberOfChannels;
  }
  return out;
}
```

Then, still on the main thread, prepare the audio:

- **Silence check**: compute RMS over 30 ms frames. If no frame is above about −45 dBFS, or less than 0.3 s of frames is above the noise floor plus 10 dB, skip ASR. Report the take as `noSpeech`, with the verdict "re-record: we couldn't hear you". This also avoids Moonshine and Whisper inventing text on silence.
- **Trim** leading and trailing non-speech, keeping 250 ms of padding on each side. This cuts compute and the risk of hallucination.
- **Normalize** the peak to about 0.9 when the peak is below 0.5. Moonshine reads the raw waveform (it has no log-mel front end), so very quiet takes hurt more than they would with Whisper.

Safari and Chrome quirks:

- iOS Safari's MediaRecorder produces `audio/mp4` (AAC). `decodeAudioData` handles it on iOS 16.4+, our minimum because of WASM SIMD. Older iOS builds sometimes failed with fragmented MP4 and threw `EncodingError`. Treat any decode failure as "Accuracy unavailable" for that take only.
- `decodeAudioData` detaches the `ArrayBuffer` you pass. Pass `bytes.slice(0)` if you might retry. Don't reuse the buffer after the call.
- Use the promise form of `decodeAudioData`. The callback-only form is pre-Safari 14.1, which is below our floor anyway.
- Safari limits how many live `AudioContext`s a page may hold. The decoder above uses `OfflineAudioContext`, which needs no user gesture and is garbage-collected. If the fallback path creates an `AudioContext`, close it every time.
- AAC adds about 2112 priming samples (≈46 ms) of silence at the start. It is harmless and gets trimmed.
- Chrome webm files from MediaRecorder have no duration in their metadata. This doesn't matter for `decodeAudioData`.
- Decode on the device that recorded. Safari decoding of webm/opus from other devices is not something we rely on.

### Scoring algorithm

`score.ts` is pure TypeScript with no dependencies, and is unit tested with Vitest.

**1. Normalize** both the script line (reference) and the transcript (hypothesis) the same way, keeping a map from each normalized token back to the display word it came from, so highlights land on the script as written:

1. Unicode NFKC, lower-case, curly quotes to `'`.
2. Replace dashes and hyphens (`-‐‑‒–—―`) with spaces. Drop stage directions in brackets or parentheses from the reference if the script parser hasn't already.
3. Split on whitespace. Strip leading and trailing punctuation except apostrophes (`/^[^\p{L}\p{N}']+|[^\p{L}\p{N}']+$/gu`). If a token is quoted ('hello'), strip the quote apostrophes unless the token is a known contraction ('tis, 'em).
4. Expand contractions with one map applied to both sides, for example: i'm→i am, it's→it is, let's→let us, don't→do not, can't/cannot→can not, won't→will not, i'd→i would, i'll→i will, 'tis→it is, 'twas→it was, o'er→over, e'en→even, ne'er→never, e'er→ever, 'em→them, gonna→going to, wanna→want to. Ambiguous 's and 'd are mapped one way on both sides, so it stays consistent. Possessives (john's) stay as they are.
5. Numbers to words on both sides: integers up to 999 999, ordinals (1st→first), and years (1100–1999 and 2010–2099 in year style: 1984→nineteen eighty four). Also & → and, % → percent, and a short abbreviation map: mr→mister, mrs→missus, dr→doctor, st only when followed by a capitalized name.
6. Remove fillers (um, uh, er, erm, ah, hmm, mm, mhm) from the **hypothesis only**, and only if that filler is not in the reference.

**2. Align** with word-level Levenshtein (dynamic programming, O(N·M); lines are under about 150 words, so this is instant):

- match cost 0; **near match** cost 0, recorded as `near`; substitution 1; deletion (missed word) 1; insertion (extra word) 1.
- Near match: `osa(a, b) <= 1` when the longer word has at least 5 characters, and `<= 2` at 9 or more characters, where `osa` is optimal-string-alignment distance, which counts a transposition as 1. This covers colour/color, theatre/theater and Petruchio/Petrucio. Short words must match exactly, so bear≠bead.
- **Compound merge**: also allow a 2-to-1 or 1-to-2 transition at cost 0 when the concatenation is equal (`to morrow` ↔ `tomorrow`, `every one` ↔ `everyone`). In the DP that means considering `dp[i-2][j-1]` and `dp[i-1][j-2]`.
- Backtrace tie-break: diagonal (match, near or substitution) before deletion before insertion. This gives the most natural highlighting.

**3. Output** per-word ops for highlighting:

```ts
type WordOp =
  | { op: 'match' | 'near'; ref: string; hyp: string; displayIndex: number }
  | { op: 'sub'; ref: string; hyp: string; displayIndex: number }
  | { op: 'del'; ref: string; displayIndex: number }          // missed word
  | { op: 'ins'; hyp: string; afterDisplayIndex: number };    // extra word, shown as an inline chip

type TakeScore = {
  n: number;            // reference word count after normalization
  s: number; d: number; i: number;
  accuracy: number;     // max(0, 1 - (s + d + i) / n)
  verdict: 'good' | 'check' | 'rerecord';
  ops: WordOp[];
  transcript: string;
  noSpeech?: boolean;
  model: 'moonshine-tiny@a6da124';
};
```

A display word is highlighted if any normalized token from it is `sub` or `del`. For example, if "don't" expands to "do not" and "not" is missing, "don't" is highlighted.

**4. Accuracy and verdict**

- Word accuracy = 1 − (S + D + I) / N, clamped to [0, 1]. Insertions can push the raw value below 0.
- N ≥ 4: **≥ 90% good**, **75–90% check**, **< 75% re-record**.
- N ≤ 3 (for example "Yes, my lord."): one error would already be a 33–100% swing, so use error counts instead. 0 errors is good, 1 error is check, 2 or more errors (or `noSpeech`) is re-record.
- Calibrate before launch. Even a perfect take will show 3–8% "errors" from ASR mistakes on phone audio. Record a pilot set (about 100 takes from 5 voices, read correctly and then deliberately with mistakes), then tune the near-match rules and thresholds so that correct takes stay at or above 90%. The thresholds live in one constant, so tuning is cheap.

**5. Summaries**

- End of recording: micro-averaged accuracy = 1 − ΣE / ΣN over the scored takes, a count of good / check / re-record, and a tappable list of the lines to re-record. Takes still in the queue show as "still checking (n)". Wait up to about 10 s for them, then show the partial summary and update it live. Unscored takes show as "accuracy unavailable" and are left out of the average.
- "My part" practice: record each of the actor's gaps as its own clip, or one continuous recording cut at the known gap boundaries, and run the same pipeline. Use `getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })` and cut strictly to the gap windows. Otherwise the run-through playback leaking into the microphone shows up as insertions. Suggest headphones in the practice screen copy.
- Optionally send `{ accuracy, verdict, transcript, model }` with the take to the API so directors can see it later. The audio is uploaded anyway, so this adds no new privacy exposure. That is a separate backend change and not required for the MVP.

### Caching and hosting the model

- **Cache API**: transformers.js stores every model file in the `transformers-cache` Cache Storage bucket, keyed by URL, and (v4, `env.useWasmCache`) the ORT WASM binary too. The second visit loads from disk in a second or two with no network. `ModelRegistry` (v4) can report cache status, which is useful for a "ready" indicator on a return visit.
- **HTTP cache**: Hugging Face answers `/resolve/` with a `Cache-Control: no-store` redirect to its CDN, so the browser HTTP cache doesn't help there. The Cache API is what we rely on.
- **Eviction**: Safari deletes all script-writable storage, Cache API included, for sites without user interaction in 7 days (ITP). An iOS actor who returns after a week re-downloads. Calling `navigator.storage.persist()` in Chromium reduces eviction under storage pressure. Everything is a cache, so correctness never depends on it.
- **MVP: load from the Hugging Face CDN** with the pinned `revision`. Verified 2026-10-13: the CDN sends `Access-Control-Allow-Origin: *` on the file responses and echoes our origin on `/resolve/`, so it works from offbooked.com with no extra setup. ORT WASM files come from jsDelivr by default (`cdn.jsdelivr.net/npm/onnxruntime-web@<version>/dist/`), and jsDelivr also sends CORS.
- **Later: self-host on our own domain**, for availability, no third-party IP exposure and version control. Copy the files of the pinned revision to `web/public/models/onnx-community/moonshine-tiny-ONNX/<revision>/...` and set `env.remoteHost = 'https://offbooked.com/models/'` and `env.remotePathTemplate = '{model}/{revision}/'`. Copy `ort-wasm-simd-threaded.{mjs,wasm}` from the installed `node_modules/onnxruntime-web/dist/` (it must be the exact installed version) to `web/public/ort/` and set `env.backends.onnx.wasm.wasmPaths`. The non-asyncify build is 14 MB versus 27 MB and is enough for WASM-only use. Serve both with `Cache-Control: public, max-age=31536000, immutable`. Same origin means no CORS or CORP concerns. Things to check first:
  - Vercel's static upload limits (Hobby 100 MB, Pro 1 GB per deployment; our largest file is 31 MB and the set is about 70 MB)
  - bandwidth: about 55–70 MB per new device
  - R2 would avoid egress cost, but an R2 custom domain needs the zone on Cloudflare, and offbooked.com DNS is on Vercel.

### Headers: COOP/COEP

**Not needed for the recommendation, so don't add them for the MVP.**

What cross-origin isolation (`Cross-Origin-Opener-Policy: same-origin` plus `Cross-Origin-Embedder-Policy: require-corp`, or `credentialless`) would buy us is `SharedArrayBuffer`, and with it multi-threaded ONNX Runtime WASM: about 2–3× faster CPU inference on 4+ core phones. WebGPU, WASM SIMD, Web Workers and the Cache API all work without it. Moonshine Tiny on one thread should already clear a 10 s take in about 1–2 s, faster than an actor records the next line.

If profiling later shows we need threads (for example to move to Moonshine Base), the cost is:

- COEP is per document. It would apply to every page that hosts the worker. It can be scoped with Vercel `headers` to only the actor recording and practice routes:

  ```json
  {
    "headers": [
      {
        "source": "/a/(.*)",
        "headers": [
          { "key": "Cross-Origin-Opener-Policy", "value": "same-origin" },
          { "key": "Cross-Origin-Embedder-Policy", "value": "require-corp" }
        ]
      }
    ]
  }
  ```

  (`/a/` stands for whatever the actor route ends up being.)
- Safari does not support `COEP: credentialless`. Only Chrome 96+ and Firefox 119+ do. So for iOS it has to be `require-corp`, and **every cross-origin subresource must then opt in**:
  - `api.offbooked.com` responses that the page loads in no-cors mode (audio in `<audio src>`, images) must send `Cross-Origin-Resource-Policy: same-site`. api.offbooked.com and offbooked.com are the same site. Alternatively, use them in CORS mode (`<audio crossorigin="anonymous">` plus `Access-Control-Allow-Origin`). `fetch()` calls are already CORS.
  - R2 presigned URLs (`*.r2.cloudflarestorage.com`) are cross-site, and we can't add CORP headers to them. Load that audio with `crossorigin="anonymous"` and configure CORS rules on the bucket for `https://offbooked.com`, or proxy it through the API.
  - Model and runtime files from HF and jsDelivr are fetched with CORS, so they keep working.
  - Third-party iframes and embeds (analytics widgets, video, payment) break unless they send CORP or COEP themselves.
- COOP `same-origin` cuts `window.opener` links, which breaks OAuth or payment popups opened from those pages. Keep director sign-in off the isolated routes.

### Testing and rollout

1. **Spike, before building UI.** Build a throwaway page under `.codex/` or a preview deployment that records and transcribes 20 fixed lines. Measure cold load time, warm latency per clip and WER on at least one mid-range Android phone, one iPhone on iOS 17 or 18, one iPhone on iOS 26, and desktop Chrome and Safari. Compare Moonshine Tiny fp32+q8, Moonshine Tiny all-q8 (the 32 MB option) and Whisper tiny.en q8. Pick the dtype mix based on the results.
2. Unit tests for `score.ts`: contractions, numbers, compounds, near matches, a 1-word line, an empty transcript, a transcript with only insertions, and highlight index mapping.
3. Ship behind a feature flag. Log (anonymously): capability check result, load time, per-take latency, how often each verdict occurs, and how often "Accuracy unavailable" happens.
4. Calibrate the thresholds on pilot data (above), then enable by default.

## Known pitfalls

- **Moonshine `max_new_tokens`**: the pipeline default is `floor(seconds) × 6`. That gives zero tokens, and an empty transcript, for takes under 1 s, and it truncates fast speech. Always pass `max_new_tokens` (see the worker code). Moonshine can also loop on repeated tokens near the cap. Collapse three or more immediate repeats of the same n-gram at the end of the transcript before scoring.
- **Silence**: never send silent or near-silent audio to the model. Gate it with the RMS check.
- **The first take must never wait**: the worker is created only after take 1's upload. Watch for accidental static imports of `@huggingface/transformers` in main-thread code, because that would pull the library into the first bundle.
- **iOS memory**: one Moonshine Tiny session plus the runtime uses about 200–300 MB. That is fine, but dispose of it when leaving the recording screens. Never load two models at once.
- **Version pinning**: transformers.js 4.3.1 is a week old and depends on an ORT dev build. Pin exactly, and when self-hosting the WASM, copy it from the installed `onnxruntime-web`. Never mix versions.
- **Do not bias toward the expected line** (no Whisper prompt containing the line, no grammar restricted to it). It hides the drift we're trying to catch.
- **Echo in practice mode**: playback bleeding into the microphone shows up as extra words. Use echo cancellation, cut to the gap windows and suggest headphones.
- **Safari 7-day storage eviction** means occasional re-downloads on iOS. Data-saver users get an opt-in instead of an automatic download.

## Sources

- Transformers.js releases (4.0.0 new runtime, `env.fetch` and `useWasmCache`; 4.3.0 Safari 26 WebGPU and Moonshine decoding fix): https://github.com/huggingface/transformers.js/releases
- Transformers.js source: `env.js`, `backends/onnx.js` (default jsDelivr wasm paths, asyncify build) and `pipelines/automatic-speech-recognition.js` (Moonshine `max_new_tokens` default): https://github.com/huggingface/transformers.js/tree/main/packages/transformers/src
- Official Moonshine web example (dtype per device, warm-up, serialized inference): https://github.com/huggingface/transformers.js-examples/tree/main/moonshine-web
- Model files and sizes from the Hugging Face API: https://huggingface.co/onnx-community/moonshine-tiny-ONNX, https://huggingface.co/onnx-community/moonshine-base-ONNX, https://huggingface.co/onnx-community/whisper-tiny.en, https://huggingface.co/onnx-community/parakeet-ctc-0.6b-ONNX
- Moonshine paper (WER versus Whisper, compute scaling with clip length): https://arxiv.org/abs/2410.15608. Moonshine v2: https://github.com/moonshine-ai/moonshine-v2
- MDN browser-compat-data for `SpeechRecognition` (`processLocally`/`available`/`install` Chrome 139 desktop, `phrases` Chrome 142, none on Chrome Android or Safari), WebGPU (Chrome Android 121, Safari 26) and COEP `credentialless` (no Safari): https://github.com/mdn/browser-compat-data
- MDN `processLocally`: https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition/processLocally
- Apple on-device recognition is native-only (`requiresOnDeviceRecognition`, WWDC19 session 256): https://developer.apple.com/videos/play/wwdc2019/256/
- vosk-browser (grammar via `KaldiRecognizer(sampleRate, grammar)`): https://github.com/ccoreilly/vosk-browser. Vosk models and WER: https://alphacephei.com/vosk/models
- sherpa-onnx WASM (build flags, `INITIAL_MEMORY=512MB`, preloaded assets): https://github.com/k2-fsa/sherpa-onnx/tree/master/wasm
- Desktop browser Whisper tiny.en timings: https://github.com/nickwebt800/browser-whisper-benchmark
- Vercel limits: https://vercel.com/docs/limits
