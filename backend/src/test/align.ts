import { ALIGN, BLANK, VOCAB_SIZE, wordTokens, type Emissions } from "../align/ctc.ts";
import type { Aligner } from "../align/model.ts";

/** What a fake speech model "hears" in a take: each word said and when it starts (ms of the recording; ms + ALIGN.onsetLagMs a multiple of 20). */
export type Heard = [word: string, ms: number][];

/**
 * Emissions as a CTC model would give them for these words: each letter clearly heard in its own
 * frame, a blank between letters, blank everywhere else. A word starting at `ms` is placed back at
 * `ms` by the aligner.
 */
export function emissionsOf(heard: Heard, frames: number): Emissions {
  const logp = new Float32Array(frames * VOCAB_SIZE);
  const sure = Math.log(0.97);
  const rest = Math.log(0.03 / (VOCAB_SIZE - 1));
  const set = (f: number, token: number) => {
    for (let k = 0; k < VOCAB_SIZE; k++) logp[f * VOCAB_SIZE + k] = k === token ? sure : rest;
  };
  for (let f = 0; f < frames; f++) set(f, BLANK);
  for (const [word, ms] of heard) {
    let f = Math.round((ms + ALIGN.onsetLagMs) / ALIGN.frameMs);
    for (const t of wordTokens(word)) {
      if (f < frames) set(f, t);
      f += 2;
    }
  }
  return { frames, vocab: VOCAB_SIZE, logp };
}

/** An aligner whose model hears what `hear` says for each take (by its length in ms); null: no model. */
export class FakeAligner implements Aligner {
  calls = 0;
  private readonly hear: (lengthMs: number) => Heard | null;

  constructor(hear: (lengthMs: number) => Heard | null) {
    this.hear = hear;
  }

  async emissions(pcm: Int16Array): Promise<Emissions | null> {
    this.calls++;
    const heard = this.hear(Math.round(pcm.length / 16));
    return heard ? emissionsOf(heard, Math.floor(pcm.length / 320)) : null;
  }

  async close(): Promise<void> {}
}
