import type { SttResult } from "../api/types";
import { decodeTo16kMono } from "../audio/decode";
import { readStorage, writeStorage } from "../lib/storage";
import { noopEngine, type SttEngine } from "./engine";
import { configuredModel } from "./models";
import { prepareForAsr } from "./prepare";
import { noSpeechResult, scoreLine } from "./score";
import { createWorkerEngine } from "./workerEngine";

export type SttStatus = "idle" | "checking" | "optin" | "loading" | "ready" | "unavailable";

export interface SttState {
  status: SttStatus;
  /** Download progress while loading, 0..1 or null when unknown. */
  progress: number | null;
  downloadMb: number;
}

const UNAVAILABLE_NOTICE_KEY = "offbooked.sttUnavailableNoticed";

/**
 * One speech-to-text session per recording or practice screen. The model loads only
 * when start() is called, scoring requests wait for it, and dispose() frees the worker.
 */
export class SttSession {
  private state: SttState;
  private listeners = new Set<() => void>();
  private engine: SttEngine;
  private ready: Promise<boolean>;
  private settleReady!: (ok: boolean) => void;
  private inFlight = new Map<string, AbortController>();
  private generation = 0;

  constructor(engine?: SttEngine) {
    const model = configuredModel();
    this.engine = engine ?? (model ? createWorkerEngine(model) : noopEngine);
    this.state = { status: "idle", progress: null, downloadMb: model?.downloadMb ?? 0 };
    this.ready = new Promise((resolve) => (this.settleReady = resolve));
  }

  getState = (): SttState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private set(patch: Partial<SttState>) {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((l) => l());
  }

  /** Checks the device and starts the model download, unless the user is saving data. */
  async start(): Promise<void> {
    if (this.state.status !== "idle") return;
    this.set({ status: "checking" });
    const generation = this.generation;
    const supported = await this.engine.isSupported();
    if (generation !== this.generation) return;
    if (!supported) return this.fail();
    const saveData = (navigator as { connection?: { saveData?: boolean } }).connection?.saveData === true;
    if (saveData) return this.set({ status: "optin" });
    this.load();
  }

  /** Loads the model after a data-saver opt-in. */
  enable(): void {
    if (this.state.status === "optin") this.load();
  }

  private load() {
    const generation = this.generation;
    const current = () => generation === this.generation;
    this.set({ status: "loading", progress: null });
    this.engine.load(({ fraction }) => current() && this.set({ progress: fraction })).then(
      () => {
        if (!current()) return;
        this.set({ status: "ready", progress: 1 });
        this.settleReady(true);
      },
      () => current() && this.fail(),
    );
  }

  private fail() {
    this.set({ status: "unavailable" });
    this.settleReady(false);
    this.engine.dispose();
  }

  /** True the first time the "not available on this device" notice should show. */
  claimUnavailableNotice(): boolean {
    if (readStorage(UNAVAILABLE_NOTICE_KEY)) return false;
    writeStorage(UNAVAILABLE_NOTICE_KEY, "1");
    return true;
  }

  /**
   * Scores a take against its line. A newer request with the same key (a re-record)
   * cancels the older one. Resolves null when scoring is unavailable, cancelled or failed.
   */
  async score(key: string, audio: Blob, expectedText: string): Promise<SttResult | null> {
    this.inFlight.get(key)?.abort();
    const controller = new AbortController();
    this.inFlight.set(key, controller);
    try {
      if (!(await this.ready) || controller.signal.aborted) return null;
      if (audio.size === 0) return noSpeechResult(expectedText);
      const prepared = prepareForAsr(await decodeTo16kMono(audio));
      if (controller.signal.aborted) return null;
      if (prepared.noSpeech) return noSpeechResult(expectedText);
      const { text } = await this.engine.transcribe(prepared.audio, expectedText, controller.signal);
      return scoreLine(expectedText, text);
    } catch {
      return null;
    } finally {
      if (this.inFlight.get(key) === controller) this.inFlight.delete(key);
    }
  }

  /**
   * Transcribes a stretch of a take that is still recording, for live word highlighting. Resolves
   * null at once when the model isn't ready, so callers fall back to the mic level alone.
   */
  async transcribeLive(audio: Float32Array, signal?: AbortSignal): Promise<string | null> {
    if (this.state.status !== "ready") return null;
    try {
      // No expected text: the token budget then follows the audio length, as the model's default does.
      const { text } = await this.engine.transcribe(audio, "", signal);
      return text;
    } catch {
      return null;
    }
  }

  /** Frees the worker and model memory. The session can be started again later. */
  dispose(): void {
    this.generation++;
    this.inFlight.forEach((c) => c.abort());
    this.inFlight.clear();
    this.settleReady(false);
    this.engine.dispose();
    this.ready = new Promise((resolve) => (this.settleReady = resolve));
    this.set({ status: "idle", progress: null });
  }
}
