import { describe, expect, it } from "vitest";
import { downmix, prepareForAsr, SAMPLE_RATE } from "./prepare";

function tone(seconds: number, amplitude: number): Float32Array {
  const out = new Float32Array(Math.round(seconds * SAMPLE_RATE));
  for (let i = 0; i < out.length; i++) out[i] = amplitude * Math.sin((2 * Math.PI * 220 * i) / SAMPLE_RATE);
  return out;
}

function concat(...parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

describe("prepareForAsr", () => {
  it("flags digital silence and near silence as no speech", () => {
    expect(prepareForAsr(new Float32Array(SAMPLE_RATE * 2)).noSpeech).toBe(true);
    expect(prepareForAsr(tone(2, 0.001)).noSpeech).toBe(true);
    expect(prepareForAsr(new Float32Array(0)).noSpeech).toBe(true);
  });

  it("flags a click too short to be speech", () => {
    expect(prepareForAsr(concat(tone(1, 0), tone(0.1, 0.5), tone(1, 0))).noSpeech).toBe(true);
  });

  it("trims silence around speech, keeping padding", () => {
    const result = prepareForAsr(concat(tone(2, 0), tone(1, 0.3), tone(2, 0)));
    expect(result.noSpeech).toBe(false);
    if (result.noSpeech) return;
    const seconds = result.audio.length / SAMPLE_RATE;
    expect(seconds).toBeGreaterThan(1.4);
    expect(seconds).toBeLessThan(1.6);
  });

  it("raises quiet takes to a usable level", () => {
    const result = prepareForAsr(concat(tone(0.5, 0), tone(1, 0.1)));
    if (result.noSpeech) throw new Error("expected speech");
    const peak = result.audio.reduce((p, v) => Math.max(p, Math.abs(v)), 0);
    expect(peak).toBeCloseTo(0.9, 1);
  });

  it("keeps a take that is loud throughout", () => {
    expect(prepareForAsr(tone(1, 0.4)).noSpeech).toBe(false);
  });
});

describe("downmix", () => {
  it("averages channels", () => {
    expect(Array.from(downmix([new Float32Array([1, 0]), new Float32Array([0, 1])]))).toEqual([0.5, 0.5]);
  });
});
