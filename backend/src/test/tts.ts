import { writeFile } from "node:fs/promises";
import type { Synthesizer } from "../tts/piper.ts";
import type { Voice } from "../tts/voices.ts";

// Stands in for Piper in tests: a tone of 250 ms per word, pitched by voice, as a 22.05 kHz WAV.
export class FakeSynthesizer implements Synthesizer {
  calls: { text: string; voice: string }[] = [];
  available = true;

  async probe(): Promise<string | null> {
    return this.available ? "fake 1" : null;
  }

  async synthesize(text: string, voice: Voice, outWav: string): Promise<void> {
    this.calls.push({ text, voice: voice.id });
    const words = text.split(/\s+/).filter(Boolean).length;
    await writeFile(outWav, toneWav(Math.max(0.3, words * 0.25), 200 + ((voice.speaker ?? 0) % 20) * 15));
  }

  async close(): Promise<void> {}
}

export function toneWav(seconds: number, frequency: number, rate = 22_050): Buffer {
  const samples = Math.round(seconds * rate);
  const buf = Buffer.alloc(44 + samples * 2);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + samples * 2, 4);
  buf.write("WAVEfmt ", 8);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * frequency * i) / rate) * 9000), 44 + i * 2);
  return buf;
}
