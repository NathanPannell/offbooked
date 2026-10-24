import { readFile, writeFile } from "node:fs/promises";

// Joins PCM WAV files from one voice (so one format) into a single WAV, with `gapMs` of silence
// between them. Piper writes one file per sentence; the gap is the pause after each one.

interface Pcm {
  fmt: Buffer; // the fmt chunk's body
  data: Buffer;
}

function readPcm(buf: Buffer, name: string): Pcm {
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") throw new Error(`${name} is not a WAV file`);
  let fmt: Buffer | null = null;
  let data: Buffer | null = null;
  for (let at = 12; at + 8 <= buf.length;) {
    const id = buf.toString("ascii", at, at + 4);
    const size = buf.readUInt32LE(at + 4);
    const body = buf.subarray(at + 8, Math.min(buf.length, at + 8 + size));
    if (id === "fmt ") fmt = body;
    else if (id === "data") data = body;
    at += 8 + size + (size % 2);
  }
  if (!fmt || !data) throw new Error(`${name} has no fmt or data chunk`);
  if (fmt.readUInt16LE(0) !== 1) throw new Error(`${name} is not PCM`);
  return { fmt, data };
}

/**
 * `gapMs` is one pause between every pair of files, or one per file: the silence before it (the
 * first is ignored). Returns where each file's audio sits in the output, in ms.
 */
export async function joinWavs(files: string[], gapMs: number | number[], output: string): Promise<{ startMs: number; endMs: number }[]> {
  const parts = await Promise.all(files.map(async (f) => readPcm(await readFile(f), f)));
  const first = parts[0];
  if (!first) throw new Error("nothing to join");
  if (parts.some((p) => !p.fmt.equals(first.fmt))) throw new Error("WAV files differ in format");
  const rate = first.fmt.readUInt32LE(4);
  const blockAlign = first.fmt.readUInt16LE(12); // bytes per sample frame, all channels
  const frames = (ms: number) => Math.round((ms / 1000) * rate);
  const toMs = (frameCount: number) => Math.round((frameCount * 1000) / rate);
  const chunks: Buffer[] = [];
  const spans: { startMs: number; endMs: number }[] = [];
  let at = 0;
  parts.forEach((p, i) => {
    if (i > 0) {
      const gap = frames(Array.isArray(gapMs) ? (gapMs[i] ?? 0) : gapMs);
      chunks.push(Buffer.alloc(gap * blockAlign));
      at += gap;
    }
    const length = Math.floor(p.data.length / blockAlign);
    spans.push({ startMs: toMs(at), endMs: toMs(at + length) });
    chunks.push(p.data);
    at += length;
  });
  const data = Buffer.concat(chunks);
  const header = Buffer.alloc(12 + 8 + first.fmt.length + 8);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(header.length - 8 + data.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(first.fmt.length, 16);
  first.fmt.copy(header, 20);
  header.write("data", 20 + first.fmt.length, "ascii");
  header.writeUInt32LE(data.length, 24 + first.fmt.length);
  await writeFile(output, Buffer.concat([header, data]));
  return spans;
}
