import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { RENDER_SETTINGS } from "../render/plan.ts";
import type { TrackPiece } from "./plan.ts";

// The ffmpeg end of a listen track (track.ts): clips decoded to raw samples, then every piece
// streamed in order into one AAC encode.

const RATE = RENDER_SETTINGS.sampleRate;

/** Any audio file as raw 48 kHz mono 16-bit samples. */
export async function decodeToPcm(input: string, output: string): Promise<void> {
  await run("ffmpeg", ["-hide_banner", "-nostdin", "-y", "-i", input, "-vn", "-ac", "1", "-ar", String(RATE), "-f", "s16le", "-acodec", "pcm_s16le", output]);
}

// Streams the pieces as raw samples into one AAC encode: each clip cut or padded to its planned
// length (an AAC frame or two either way from the FLAC it was made from), silences as zeros.
export async function encodeTrack(pieces: TrackPiece[], pcm: Map<string, string>, output: string, bitrate: string): Promise<void> {
  const child = spawn(
    "ffmpeg",
    ["-hide_banner", "-y", "-f", "s16le", "-ar", String(RATE), "-ac", "1", "-i", "pipe:0", "-c:a", "aac", "-b:a", bitrate, "-movflags", "+faststart", output],
    { stdio: ["pipe", "ignore", "pipe"] },
  );
  let stderr = "";
  child.stderr.on("data", (d: Buffer) => (stderr = (stderr + d.toString()).slice(-2000)));
  // An encoder that died early fails the build below with its own message, not an EPIPE.
  child.stdin.on("error", () => undefined);
  const exited = new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  const write = async (chunk: Buffer) => {
    if (!child.stdin.write(chunk)) await Promise.race([once(child.stdin, "drain"), exited]);
  };
  const SECOND = Buffer.alloc(RATE * 2);
  const zeros = async (samples: number) => {
    for (let left = samples * 2; left > 0; left -= SECOND.length) await write(left >= SECOND.length ? SECOND : SECOND.subarray(0, left));
  };
  try {
    for (const piece of pieces) {
      if (piece.kind === "silence") {
        await zeros(piece.samples);
        continue;
      }
      const data = await readFile(pcm.get(piece.key)!);
      const bytes = piece.samples * 2;
      await write(data.subarray(0, Math.min(bytes, data.length - (data.length % 2))));
      if (data.length < bytes) await zeros(Math.ceil((bytes - data.length) / 2));
    }
  } finally {
    child.stdin.end();
  }
  const code = await exited;
  if (code !== 0) throw new Error(`ffmpeg failed encoding the track (${code}): ${stderr.trim().split("\n").pop() ?? ""}`);
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => (stderr = (stderr + d.toString()).slice(-2000)));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} failed (${code}): ${stderr.trim().split("\n").pop() ?? ""}`))));
  });
}
