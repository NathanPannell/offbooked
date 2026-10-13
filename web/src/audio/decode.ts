import { downmix, SAMPLE_RATE } from "../stt/prepare";

type OfflineCtor = typeof OfflineAudioContext;

function offlineContextClass(): OfflineCtor | undefined {
  const w = window as unknown as { OfflineAudioContext?: OfflineCtor; webkitOfflineAudioContext?: OfflineCtor };
  return w.OfflineAudioContext ?? w.webkitOfflineAudioContext;
}

/**
 * Decodes a recorded blob to 16 kHz mono Float32. Must run on the main thread
 * (no audio contexts in workers). Decode failures throw; callers treat them as
 * "accuracy unavailable" for that take only.
 */
export async function decodeTo16kMono(blob: Blob): Promise<Float32Array> {
  const Offline = offlineContextClass();
  if (!Offline) throw new Error("Audio decoding is not supported");
  const bytes = await blob.arrayBuffer();
  let buffer: AudioBuffer;
  try {
    // decodeAudioData resamples to the context's rate. It detaches its input, hence the copy.
    buffer = await new Offline(1, 1, SAMPLE_RATE).decodeAudioData(bytes.slice(0));
  } catch {
    // Some engines refuse a 16 kHz context: decode at the device rate, then render down.
    const ctx = new AudioContext();
    try {
      buffer = await ctx.decodeAudioData(bytes);
    } finally {
      void ctx.close();
    }
  }
  if (buffer.sampleRate !== SAMPLE_RATE) buffer = await resample(Offline, buffer);
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c));
  return downmix(channels);
}

async function resample(Offline: OfflineCtor, buffer: AudioBuffer): Promise<AudioBuffer> {
  const ctx = new Offline(1, Math.max(1, Math.ceil(buffer.duration * SAMPLE_RATE)), SAMPLE_RATE);
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(ctx.destination);
  source.start();
  return ctx.startRendering();
}
