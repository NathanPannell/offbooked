export interface LoadProgress {
  /** 0..1, or null while the total size is unknown. */
  fraction: number | null;
}

/** A speech-to-text engine. Audio is 16 kHz mono Float32. */
export interface SttEngine {
  readonly id: string;
  isSupported(): Promise<boolean>;
  load(onProgress: (progress: LoadProgress) => void): Promise<void>;
  /** `expectedText` only sizes the decoder's token budget. It never biases recognition. */
  transcribe(audio: Float32Array, expectedText: string, signal?: AbortSignal): Promise<{ text: string }>;
  dispose(): void;
}

export const noopEngine: SttEngine = {
  id: "none",
  isSupported: async () => false,
  load: async () => {
    throw new Error("Speech recognition is not available on this device");
  },
  transcribe: async () => {
    throw new Error("Speech recognition is not available on this device");
  },
  dispose: () => {},
};
