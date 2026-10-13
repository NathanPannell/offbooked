// Silence gate, trim and level for 16 kHz mono audio before transcription (docs/on-device-stt.md).

export const SAMPLE_RATE = 16_000;
const FRAME = Math.round(SAMPLE_RATE * 0.03);
const SPEECH_FLOOR_DB = -45;
const ABOVE_NOISE_DB = 10;
const MIN_SPEECH_SECONDS = 0.3;
const PAD_SECONDS = 0.25;

export function frameDb(audio: Float32Array): number[] {
  const out: number[] = [];
  for (let start = 0; start < audio.length; start += FRAME) {
    const end = Math.min(audio.length, start + FRAME);
    let sum = 0;
    for (let i = start; i < end; i++) sum += audio[i] * audio[i];
    const rms = Math.sqrt(sum / Math.max(1, end - start));
    out.push(rms > 0 ? 20 * Math.log10(rms) : -120);
  }
  return out;
}

export type Prepared = { noSpeech: true } | { noSpeech: false; audio: Float32Array };

/** Returns trimmed, levelled audio, or `noSpeech` when the take is (near) silent. */
export function prepareForAsr(audio: Float32Array): Prepared {
  const db = frameDb(audio);
  if (db.length === 0) return { noSpeech: true };
  const sorted = [...db].sort((a, b) => a - b);
  const noiseFloor = sorted[Math.floor(sorted.length * 0.1)];
  const threshold = Math.max(SPEECH_FLOOR_DB, noiseFloor + ABOVE_NOISE_DB);
  const voiced = db.map((d) => d > threshold);
  const voicedSeconds = (voiced.filter(Boolean).length * FRAME) / SAMPLE_RATE;
  // A take that is loud throughout (noise floor already above -45 dBFS) still counts as speech.
  const loudThroughout = noiseFloor > SPEECH_FLOOR_DB && db.some((d) => d > SPEECH_FLOOR_DB);
  if (!loudThroughout && voicedSeconds < MIN_SPEECH_SECONDS) return { noSpeech: true };

  const first = loudThroughout ? 0 : voiced.indexOf(true);
  const last = loudThroughout ? db.length - 1 : voiced.lastIndexOf(true);
  const pad = Math.round(PAD_SECONDS * SAMPLE_RATE);
  const start = Math.max(0, first * FRAME - pad);
  const end = Math.min(audio.length, (last + 1) * FRAME + pad);
  const trimmed = audio.slice(start, end);

  let peak = 0;
  for (let i = 0; i < trimmed.length; i++) peak = Math.max(peak, Math.abs(trimmed[i]));
  if (peak > 0 && peak < 0.5) {
    const gain = 0.9 / peak;
    for (let i = 0; i < trimmed.length; i++) trimmed[i] *= gain;
  }
  return { noSpeech: false, audio: trimmed };
}

/** Averages channels into one. */
export function downmix(channels: Float32Array[]): Float32Array {
  if (channels.length === 1) return channels[0].slice();
  const out = new Float32Array(channels[0].length);
  for (const channel of channels) {
    for (let i = 0; i < out.length; i++) out[i] += channel[i] / channels.length;
  }
  return out;
}
