// One microphone stream per session, reused for every take. Opened only from a user tap.

import { LiveCapture } from "./liveCapture";

const MIME_CANDIDATES = ["audio/webm;codecs=opus", "audio/mp4;codecs=mp4a.40.2", "audio/mp4", "audio/webm", "audio/ogg;codecs=opus"];

export function pickMimeType(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  return MIME_CANDIDATES.find((type) => MediaRecorder.isTypeSupported?.(type));
}

export function canRecord(): boolean {
  return typeof MediaRecorder !== "undefined" && !!navigator.mediaDevices?.getUserMedia;
}

export type MicErrorKind = "denied" | "no-mic" | "busy" | "insecure" | "unsupported" | "unknown";

export class MicError extends Error {
  constructor(readonly kind: MicErrorKind, message: string) {
    super(message);
  }
}

function toMicError(err: unknown): MicError {
  const name = err instanceof DOMException ? err.name : "";
  if (name === "NotAllowedError" || name === "PermissionDeniedError") return new MicError("denied", "Microphone access was blocked.");
  if (name === "SecurityError") return new MicError("insecure", "This page isn't allowed to use the microphone.");
  if (name === "NotFoundError" || name === "OverconstrainedError") return new MicError("no-mic", "No microphone was found.");
  if (name === "NotReadableError" || name === "AbortError") return new MicError("busy", "Another app is using the microphone.");
  return new MicError("unknown", err instanceof Error ? err.message : "The microphone didn't start.");
}

export interface RecordedTake {
  blob: Blob;
  durationMs: number;
}

export interface ActiveTake {
  /** Stops recording and resolves with the take. */
  stop(): Promise<RecordedTake>;
  /** Stops and throws the audio away. */
  cancel(): void;
}

type AudioContextCtor = typeof AudioContext;

export class MicSession {
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  analyser: AnalyserNode | null = null;
  /** Live 16 kHz samples for word highlighting, where AudioWorklet is available. */
  capture: LiveCapture | null = null;

  constructor(private readonly constraints: MediaTrackConstraints = { echoCancellation: true, noiseSuppression: true, autoGainControl: true }) {}

  get isOpen(): boolean {
    return !!this.stream && this.stream.getAudioTracks().some((t) => t.readyState === "live");
  }

  /** Requests the mic (the browser prompts the first time). Call from a tap. */
  async open(): Promise<void> {
    if (this.isOpen) {
      await this.context?.resume().catch(() => {});
      return;
    }
    if (!window.isSecureContext) throw new MicError("insecure", "The microphone needs a secure (https) page.");
    if (!canRecord()) throw new MicError("unsupported", "This browser can't record audio.");
    this.close();
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: this.constraints });
    } catch (err) {
      throw toMicError(err);
    }
    const Ctor: AudioContextCtor | undefined =
      window.AudioContext ?? (window as unknown as { webkitAudioContext?: AudioContextCtor }).webkitAudioContext;
    if (Ctor) {
      // Only for the level meter; never connected to the speakers.
      this.context = new Ctor();
      this.source = this.context.createMediaStreamSource(this.stream);
      this.analyser = this.context.createAnalyser();
      this.analyser.fftSize = 1024;
      this.source.connect(this.analyser);
      await this.context.resume().catch(() => {});
      this.capture = await LiveCapture.attach(this.context, this.source).catch(() => null);
    }
  }

  /** Starts a take. It stops itself after `maxMs` and calls `onLimit`. */
  start(maxMs: number, onLimit: () => void): ActiveTake {
    if (!this.stream) throw new MicError("unknown", "The microphone isn't open.");
    const mimeType = pickMimeType();
    const recorder = new MediaRecorder(this.stream, mimeType ? { mimeType } : undefined);
    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunks.push(e.data);
    };
    const startedAt = performance.now();
    const stopped = new Promise<RecordedTake>((resolve, reject) => {
      recorder.onstop = () => {
        const type = recorder.mimeType || mimeType || chunks[0]?.type || "audio/webm";
        resolve({ blob: new Blob(chunks, { type }), durationMs: performance.now() - startedAt });
      };
      recorder.onerror = () => reject(new MicError("unknown", "Recording failed."));
    });
    // A timeslice keeps data flowing on Safari, which can otherwise drop a long take.
    recorder.start(1000);
    const limit = setTimeout(() => {
      if (recorder.state !== "inactive") {
        recorder.stop();
        onLimit();
      }
    }, maxMs);

    return {
      stop: () => {
        clearTimeout(limit);
        if (recorder.state !== "inactive") recorder.stop();
        return stopped;
      },
      cancel: () => {
        clearTimeout(limit);
        recorder.onstop = null;
        if (recorder.state !== "inactive") recorder.stop();
      },
    };
  }

  close(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.capture?.disconnect();
    this.source?.disconnect();
    void this.context?.close().catch(() => {});
    this.stream = null;
    this.context = null;
    this.source = null;
    this.analyser = null;
    this.capture = null;
  }
}
