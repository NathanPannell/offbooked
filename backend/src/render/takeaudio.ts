import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Ctx } from "../context.ts";
import { ContentDeletedError, sweepIfDeleted } from "../retention.ts";
import { realignWordStarts } from "../realign.ts";
import { flattenStretches, wordAnchors } from "../taketiming.ts";
import { encodeCue, normalizeClipCut } from "./ffmpeg.ts";
import type { Stretch } from "./trim.ts";

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
  // Made just now: where the voice is in the clip (flat [start, end, ...] ms), where the upload was cut,
  // and the word starts re-timed on the voice (realign.ts), in ms of the upload.
  speechMs?: number[];
  trimStartMs?: number;
  wordStartsMs?: number[];
}

// Takes normalized by an older pipeline are made again on first use: the key names the version, so
// an old FLAC is never mistaken for a current one. No migration or backfill job needed: the next
// render or playback of each take redoes it once. t2: cut to the speech (trim.ts). t3: light noise
// clean-up and two-pass loudness, so every take plays at the same level as the TTS. t4: the cut is
// anchored on voiced sound, so breaths and bumps at the ends go too (trim.ts). t5: cut by the line's
// words when the app heard them (`wordBounds`), re-timed on the voice first. t6: one decode of the
// upload (cleaned at 48 kHz beside the 16 kHz copy for the speech), loudness measured in-process.
// t7: a quarter second kept on both sides of the speech (TRIM pads 250/250 ms, were 150/180).
export const NORMALIZE_VERSION = "t7";
export const isCurrentNormalized = (key: string | null): key is string => Boolean(key?.endsWith(`.${NORMALIZE_VERSION}.flac`));

// Each take is normalized as soon as it is uploaded (normalizeSoon), so the recorder, the cues and
// the run-through get its cut, levelled clip and its words re-timed on the voice (realign.ts) at
// once rather than on first play. One at a time, in upload order, at most MAX_WAITING waiting (the
// rest are normalized on first use, as before). Driven only by uploads: nothing polls or sleeps.
export const MAX_WAITING = 200;
const queues = new WeakMap<Ctx, { waiting: (() => Promise<unknown>)[]; draining: boolean }>();

export function normalizeSoon(ctx: Ctx, productionId: string, take: TakeAudioRow): void {
  if (!ctx.config.normalizeOnUpload) return;
  let q = queues.get(ctx);
  if (!q) queues.set(ctx, (q = { waiting: [], draining: false }));
  if (q.waiting.length >= MAX_WAITING) return;
  q.waiting.push(async () => {
    try {
      // As it is now: a listener or the render may have normalized it while it waited.
      const [row] = await ctx.sql<TakeAudioRow[]>`
        select id, storage_key, normalized_key, normalized_samples, stream_key from takes where id = ${take.id} and deleted_at is null`;
      if (row) await normalizedTake(ctx, productionId, row, { stream: true });
    } catch (err) {
      if (!(err instanceof ContentDeletedError)) ctx.log.error({ err, takeId: take.id }, "take normalization failed");
    }
  });
  if (q.draining) return;
  q.draining = true;
  const queue = q;
  ctx.jobs.run("normalize uploaded takes", async () => {
    try {
      while (queue.waiting.length) await queue.waiting.shift()!();
    } finally {
      queue.draining = false;
    }
  });
}

/** Drops the takes still waiting (shutting down): each is normalized on first use instead. */
export function stopNormalizing(ctx: Ctx): void {
  const q = queues.get(ctx);
  if (q) q.waiting.length = 0;
}

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
  const have =
    isCurrentNormalized(take.normalizedKey) && take.normalizedSamples ? { normalizedKey: take.normalizedKey, samples: take.normalizedSamples } : null;
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

interface TakeWords {
  wordStartsMs: number[] | null;
  text: string;
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
      if (await sweepIfDeleted(ctx, productionId)) throw new ContentDeletedError();
      await sql`update takes set stream_key = ${streamKey} where id = ${take.id}`;
      return { ...have, streamKey };
    }
    const source = path.join(dir, `source${path.extname(take.storageKey)}`);
    await writeFile(source, await storage.get(take.storageKey));
    // The app's word starts are re-timed on the take's voice (realign.ts), and the cut follows those
    // words (trim.ts `wordBounds`): one analysis, the same voiced stretches, so they agree.
    const [words] = await sql<TakeWords[]>`select t.word_starts_ms, l.text from takes t join lines l on l.id = t.line_id where t.id = ${take.id}`;
    let aligned: number[] | null = null;
    const onVoice = words?.wordStartsMs?.length
      ? (voice: Stretch[]) => {
          aligned = realignWordStarts(words.wordStartsMs, words.text, voice);
          // Live starts that don't fit the voice aren't re-timed, and don't guide the cut either.
          return aligned && wordAnchors(aligned, words.text);
        }
      : null;
    const { samples, cutStartMs, speech } = await normalizeClipCut(source, flac, m4a, { clean: true, words: onVoice });
    const normalizedKey = `productions/${productionId}/normalized/${take.id}.${NORMALIZE_VERSION}.flac`;
    await Promise.all([storage.put(normalizedKey, await readFile(flac), "audio/flac"), storage.put(streamKey, await readFile(m4a), "audio/mp4")]);
    if (await sweepIfDeleted(ctx, productionId)) throw new ContentDeletedError();
    // Where the voice is in the clip as served, and where it was cut from the upload (for the word starts).
    await sql`
      update takes set normalized_key = ${normalizedKey}, normalized_samples = ${samples}, stream_key = ${streamKey},
        speech_ms = ${flattenStretches(speech)}::int[], trim_start_ms = ${Math.round(cutStartMs)},
        aligned_word_starts_ms = ${aligned}::int[]
      where id = ${take.id}`;
    return {
      normalizedKey,
      samples,
      streamKey,
      speechMs: flattenStretches(speech),
      trimStartMs: Math.round(cutStartMs),
      ...(aligned ? { wordStartsMs: aligned } : {}),
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
