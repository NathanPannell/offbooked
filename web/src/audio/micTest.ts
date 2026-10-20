import { MicError, type ActiveTake } from "./recorder";

/** The part of a mic session the mic test uses (MicSession in the app, a fake in tests). */
export interface TestMic {
  open(): Promise<void>;
  start(maxMs: number, onLimit: () => void): ActiveTake;
  close(): void;
}

/**
 * Records a short sample for the mic test: opens the mic (the browser may ask), records `ms`, and
 * always closes the mic again, so the test never holds it open. `onListening` fires once the mic
 * is recording. Failures come back as a MicError, for MicHelp.
 */
export async function recordSample(
  mic: TestMic,
  ms: number,
  { onListening, wait = (t: number) => new Promise<void>((r) => setTimeout(r, t)) }: { onListening?: () => void; wait?: (ms: number) => Promise<void> } = {},
): Promise<Blob> {
  try {
    await mic.open();
    const take = mic.start(ms + 1000, () => {});
    onListening?.();
    await wait(ms);
    const clip = await take.stop();
    if (clip.blob.size === 0) throw new MicError("unknown", "The microphone didn't pick anything up.");
    return clip.blob;
  } catch (err) {
    throw err instanceof MicError ? err : new MicError("unknown", "The microphone didn't start.");
  } finally {
    mic.close();
  }
}
