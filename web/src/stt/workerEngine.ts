import { simd } from "wasm-feature-detect";
import type { LoadProgress, SttEngine } from "./engine";
import type { SttModel } from "./models";
import type { FromWorker, ToWorker } from "./protocol";

/** Capability checks from docs/on-device-stt.md. Any failure means scoring is off for the session. */
async function canRun(): Promise<boolean> {
  try {
    if (typeof Worker === "undefined" || typeof WebAssembly === "undefined") return false;
    if (typeof OfflineAudioContext === "undefined" && !("webkitOfflineAudioContext" in window)) return false;
    if (!("caches" in self)) return false;
    if (!(await simd())) return false; // ONNX Runtime Web ships SIMD builds only (iOS < 16.4 fails here).
    const memory = (navigator as { deviceMemory?: number }).deviceMemory;
    if (memory !== undefined && memory < 2) return false;
    const estimate = await navigator.storage?.estimate?.();
    if (estimate?.quota !== undefined && estimate.quota - (estimate.usage ?? 0) < 200e6) return false;
    return true;
  } catch {
    return false;
  }
}

/** transformers.js in a module worker. Created lazily on load(). */
export function createWorkerEngine(model: SttModel): SttEngine {
  let worker: Worker | null = null;
  let loading: Promise<void> | null = null;
  let fatal: Error | null = null;
  let nextJob = 0;
  const pending = new Map<string, { resolve: (v: { text: string }) => void; reject: (e: Error) => void }>();
  const loadListeners = new Set<(p: LoadProgress) => void>();

  const failAll = (error: Error) => {
    fatal = error;
    for (const job of pending.values()) job.reject(error);
    pending.clear();
  };

  const send = (message: ToWorker, transfer: Transferable[] = []) => worker?.postMessage(message, transfer);

  return {
    id: model.id,
    isSupported: canRun,
    load(onProgress) {
      loadListeners.add(onProgress);
      if (loading) return loading;
      loading = new Promise<void>((resolve, reject) => {
        worker = new Worker(new URL("./stt.worker.ts", import.meta.url), { type: "module" });
        worker.onmessage = (event: MessageEvent<FromWorker>) => {
          const message = event.data;
          if (message.type === "progress") {
            const fraction = message.total > 0 ? Math.min(1, message.loaded / message.total) : null;
            loadListeners.forEach((listener) => listener({ fraction }));
          } else if (message.type === "ready") {
            resolve();
          } else if (message.type === "result") {
            pending.get(message.jobId)?.resolve({ text: message.text });
            pending.delete(message.jobId);
          } else if (message.jobId) {
            pending.get(message.jobId)?.reject(new Error(message.message));
            pending.delete(message.jobId);
          } else {
            const error = new Error(message.message);
            failAll(error);
            reject(error);
            worker?.terminate();
          }
        };
        worker.onerror = (event) => {
          const error = new Error(event.message || "Speech worker crashed");
          failAll(error);
          reject(error);
          worker?.terminate();
        };
        send({ type: "load", model });
      });
      return loading;
    },
    transcribe(audio, expected, signal) {
      if (fatal) return Promise.reject(fatal);
      if (!worker) return Promise.reject(new Error("Speech engine not loaded"));
      const jobId = String(nextJob++);
      return new Promise((resolve, reject) => {
        pending.set(jobId, { resolve, reject });
        signal?.addEventListener("abort", () => {
          if (!pending.delete(jobId)) return;
          send({ type: "cancel", jobId });
          reject(new DOMException("Cancelled", "AbortError"));
        });
        send({ type: "transcribe", jobId, audio, expected }, [audio.buffer]);
      });
    },
    dispose() {
      if (worker) send({ type: "dispose" });
      failAll(new Error("Speech engine disposed"));
      worker = null;
      loading = null;
      fatal = null;
      loadListeners.clear();
    },
  };
}
