import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Ctx } from "../context.ts";
import { encodeCue, normalizeClip } from "./ffmpeg.ts";

export interface TakeAudioRow {
  id: string;
  storageKey: string;
  normalizedKey: string | null;
  normalizedSamples: number | null;
  streamKey: string | null;
}

export interface NormalizedTake {
  normalizedKey: string; // 48 kHz mono FLAC, what the render stitches
  samples: number;
  streamKey: string | null; // AAC .m4a for line-by-line playback, when asked for
}

// Takes normalized by an older pipeline are made again on first use: the key names the version, so
// an old FLAC is never mistaken for a current one. No migration or backfill job needed: the next
// render or playback of each take redoes it once. t2: cut to the speech (trim.ts). t3: light noise
// clean-up and two-pass loudness, so every take plays at the same level as the TTS.
export const NORMALIZE_VERSION = "t3";
export const isCurrentNormalized = (key: string | null): key is string => Boolean(key?.endsWith(`.${NORMALIZE_VERSION}.flac`));

// Concurrent requests for the same take (a render and a listener) share one ffmpeg run.
const inflight = new Map<string, Promise<NormalizedTake>>();

// A take's normalized audio, made and cached in storage on first use. The render passes `flacTo` to
// get the FLAC written to its work directory; line playback passes `stream` to also get the .m4a.
// Normalizing writes both files in one ffmpeg run, so whichever comes first makes both.
export async function normalizedTake(
  ctx: Ctx,
  productionId: string,
  take: TakeAudioRow,
  opts: { stream?: boolean; flacTo?: string } = {},
): Promise<NormalizedTake> {
  const { storage } = ctx;
  const have = isCurrentNormalized(take.normalizedKey) && take.normalizedSamples ? { normalizedKey: take.normalizedKey, samples: take.normalizedSamples } : null;
  if (have && (take.streamKey || !opts.stream) && (await storage.exists(have.normalizedKey))) {
    if (opts.flacTo) await writeFile(opts.flacTo, await storage.get(have.normalizedKey));
    return { ...have, streamKey: take.streamKey };
  }
  let running = inflight.get(take.id);
  if (!running) {
    running = make(ctx, productionId, take, have).finally(() => inflight.delete(take.id));
    inflight.set(take.id, running);
  }
  const done = await running;
  if (opts.flacTo) await writeFile(opts.flacTo, await storage.get(done.normalizedKey));
  return done;
}

async function make(ctx: Ctx, productionId: string, take: TakeAudioRow, have: { normalizedKey: string; samples: number } | null): Promise<NormalizedTake> {
  const { storage, sql } = ctx;
  const dir = await mkdtemp(path.join(tmpdir(), "offbooked-take-"));
  try {
    const flac = path.join(dir, "take.flac");
    const m4a = path.join(dir, "take.m4a");
    const streamKey = `productions/${productionId}/normalized/${take.id}.${NORMALIZE_VERSION}.m4a`;
    if (have && (await storage.exists(have.normalizedKey))) {
      // Normalized before takes had an .m4a: encode one from the FLAC.
      await writeFile(flac, await storage.get(have.normalizedKey));
      await encodeCue(flac, m4a);
      await storage.put(streamKey, await readFile(m4a), "audio/mp4");
      await sql`update takes set stream_key = ${streamKey} where id = ${take.id}`;
      return { ...have, streamKey };
    }
    const source = path.join(dir, `source${path.extname(take.storageKey)}`);
    await writeFile(source, await storage.get(take.storageKey));
    const samples = await normalizeClip(source, flac, m4a, { clean: true });
    const normalizedKey = `productions/${productionId}/normalized/${take.id}.${NORMALIZE_VERSION}.flac`;
    await Promise.all([
      storage.put(normalizedKey, await readFile(flac), "audio/flac"),
      storage.put(streamKey, await readFile(m4a), "audio/mp4"),
    ]);
    await sql`update takes set normalized_key = ${normalizedKey}, normalized_samples = ${samples}, stream_key = ${streamKey} where id = ${take.id}`;
    return { normalizedKey, samples, streamKey };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
