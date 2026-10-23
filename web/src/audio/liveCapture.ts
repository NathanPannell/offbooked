// Raw 16 kHz mono samples from the open mic while a take records, for live word highlighting and
// the silence detector. An AudioWorklet downsamples on the audio thread and posts 100 ms blocks.
// Each take is a generation: when one take hands on to the next, the block the worklet flushes for
// the old take is told apart from the new take's first samples, which start on the next frame.

export const CAPTURE_RATE = 16_000;

// Plain JS, loaded from a blob URL so it needs no separate bundle entry.
const WORKLET_SOURCE = `
class OffbookedCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / ${CAPTURE_RATE};
    this.pos = 0;
    this.acc = 0;
    this.count = 0;
    this.out = new Float32Array(${CAPTURE_RATE / 10});
    this.n = 0;
    this.on = false;
    this.gen = 0;
    this.port.onmessage = (event) => {
      const { cmd, gen } = event.data;
      if (cmd === "on") {
        this.flush();
        this.on = true;
        this.gen = gen;
        this.pos = 0; this.acc = 0; this.count = 0; this.n = 0;
      } else if (cmd === "off" && gen === this.gen) {
        this.flush();
        this.on = false;
      }
    };
  }
  flush() {
    if (this.n > 0) {
      this.port.postMessage({ gen: this.gen, samples: this.out.slice(0, this.n) });
      this.n = 0;
    }
  }
  process(inputs) {
    const input = inputs[0];
    const channel = input && input[0];
    if (!this.on || !channel) return true;
    for (let i = 0; i < channel.length; i++) {
      this.acc += channel[i];
      this.count++;
      this.pos += 1;
      if (this.pos >= this.ratio) {
        this.pos -= this.ratio;
        this.out[this.n++] = this.acc / this.count;
        this.acc = 0;
        this.count = 0;
        if (this.n === this.out.length) this.flush();
      }
    }
    return true;
  }
}
registerProcessor("offbooked-capture", OffbookedCapture);
`;

type Listener = (chunk: Float32Array) => void;

/** Samples kept for the live transcription, which reads at most the last 10 s: 30 s at 16 kHz. */
export const KEEP_SAMPLES = 16_000 * 30;

export class LiveCapture {
  private chunks: Float32Array[] = [];
  private listeners = new Set<Listener>();
  /** Samples captured since begin(). */
  length = 0;
  /** Samples at the start of the take no longer kept, so a take of any length stays small. */
  private dropped = 0;
  private kept = 0;
  /** The take being captured; blocks from an earlier one are dropped. */
  private gen = 0;

  private constructor(private readonly node: AudioWorkletNode) {
    node.port.onmessage = (event: MessageEvent<{ gen: number; samples: Float32Array }>) => {
      if (event.data.gen !== this.gen) return;
      const chunk = event.data.samples;
      this.chunks.push(chunk);
      this.length += chunk.length;
      this.kept += chunk.length;
      while (this.chunks.length > 1 && this.kept - this.chunks[0]!.length >= KEEP_SAMPLES) {
        const old = this.chunks.shift()!;
        this.kept -= old.length;
        this.dropped += old.length;
      }
      this.listeners.forEach((l) => l(chunk));
    };
  }

  /** Adds the capture node to an open mic graph. Resolves null where AudioWorklet isn't available. */
  static async attach(context: AudioContext, source: AudioNode): Promise<LiveCapture | null> {
    if (!context.audioWorklet || typeof AudioWorkletNode === "undefined") return null;
    const url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: "application/javascript" }));
    try {
      await context.audioWorklet.addModule(url);
      const node = new AudioWorkletNode(context, "offbooked-capture", { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: "explicit" });
      // Silent path to the output so every browser keeps pulling the node.
      const mute = context.createGain();
      mute.gain.value = 0;
      source.connect(node);
      node.connect(mute);
      mute.connect(context.destination);
      return new LiveCapture(node);
    } catch {
      return null;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  /** Starts a fresh buffer for a new take, and returns the take for `end`. A take still capturing ends here, with no gap between them. */
  begin(): number {
    this.chunks = [];
    this.length = 0;
    this.dropped = 0;
    this.kept = 0;
    this.node.port.postMessage({ cmd: "on", gen: ++this.gen });
    return this.gen;
  }

  /** Stops capturing take `gen` (from `begin`); nothing when another take has begun since. */
  end(gen: number): void {
    this.node.port.postMessage({ cmd: "off", gen });
  }

  /** Copies samples [from, to) of the current take; samples older than KEEP_SAMPLES come back as silence. */
  slice(from = 0, to = this.length): Float32Array {
    const out = new Float32Array(Math.max(0, to - from));
    let offset = this.dropped;
    for (const chunk of this.chunks) {
      const start = Math.max(from - offset, 0);
      const end = Math.min(to - offset, chunk.length);
      if (end > start) out.set(chunk.subarray(start, end), offset + start - from);
      offset += chunk.length;
      if (offset >= to) break;
    }
    return out;
  }

  onChunk(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  disconnect(): void {
    this.listeners.clear();
    this.node.port.onmessage = null;
    this.node.disconnect();
  }
}
