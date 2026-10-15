// Silent WAV files made in the browser. The player plays these through its <audio> element for the
// pauses between lines, the actor's own lines in my-part mode and while a clip is still loading,
// so playback is one continuous stream of `ended` events: no timers, which phones throttle with
// the screen locked, and the element stays unlocked for autoplay after the first tap.

const RATE = 8000;
const cache = new Map<number, string>();

export function silenceWav(ms: number): Uint8Array<ArrayBuffer> {
  const samples = Math.max(1, Math.round((ms * RATE) / 1000));
  const bytes = new Uint8Array(44 + samples * 2);
  const view = new DataView(bytes.buffer);
  const text = (offset: number, s: string) => [...s].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  text(0, "RIFF");
  view.setUint32(4, 36 + samples * 2, true);
  text(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, RATE, true);
  view.setUint32(28, RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, samples * 2, true);
  return bytes;
}

const MAX_CACHED = 40;

/** A blob URL for `ms` of silence (to 10 ms, or 100 ms past a second), made once per length. */
export function silenceUrl(ms: number): string {
  const step = ms > 1000 ? 100 : 10;
  const key = Math.max(10, Math.round(ms / step) * step);
  let url = cache.get(key);
  if (url) {
    cache.delete(key); // most recently used goes last
  } else {
    url = URL.createObjectURL(new Blob([silenceWav(key)], { type: "audio/wav" }));
    if (cache.size >= MAX_CACHED) {
      const [oldKey, oldUrl] = cache.entries().next().value!;
      cache.delete(oldKey);
      URL.revokeObjectURL(oldUrl);
    }
  }
  cache.set(key, url);
  return url;
}
