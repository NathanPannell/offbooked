import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Ctx } from "../context.ts";
import type { Sql } from "../db.ts";
import { mixClips } from "./ffmpeg.ts";
import { NORMALIZE_VERSION, normalizedTake, type TakeAudioRow } from "./takeaudio.ts";

// A shared line plays its voices' takes together: each take normalized as usual, laid over each
// other from their first word, then levelled again as one clip. Mixes are cached in storage and in
// take_mixes by a hash of the takes, so a new take by any voice makes a new mix.

export const MIX_VERSION = `m1.${NORMALIZE_VERSION}`;

export interface MixedClip {
  hash: string;
  normalizedKey: string;
  samples: number;
  streamKey: string;
}

export const mixHash = (takeIds: string[]) =>
  createHash("sha256")
    .update(`${MIX_VERSION}|${[...new Set(takeIds)].sort().join(",")}`)
    .digest("hex")
    .slice(0, 32);

export interface VoiceTake extends TakeAudioRow {
  lineId: string;
  characterId: string;
  recordedBy: "actor" | "standin";
}

// Each shared line's current take per voice (newest take for that character: see voice_take in
// migrations/011_shared_lines.sql), in voice order. Lines without voice takes are left out.
export async function voiceTakes(sql: Sql, productionId: string, lineIds?: string[]): Promise<Map<string, VoiceTake[]>> {
  const rows = await sql<VoiceTake[]>`
    select lv.line_id, lv.character_id, t.id, t.storage_key, t.normalized_key, t.normalized_samples, t.stream_key, t.recorded_by
    from line_voices lv join takes t on t.id = voice_take(lv.line_id, true, lv.character_id, false)
    where lv.production_id = ${productionId} and lv.shared ${lineIds ? sql`and lv.line_id = any(${lineIds}::uuid[])` : sql``}
    order by lv.seq, lv.ord`;
  const out = new Map<string, VoiceTake[]>();
  for (const r of rows) {
    const list = out.get(r.lineId) ?? [];
    // One actor can say two of a line's voices with one take.
    if (!list.some((t) => t.id === r.id)) list.push(r);
    out.set(r.lineId, list);
  }
  return out;
}

const inflight = new Map<string, Promise<MixedClip>>();

// The mix of two or more takes, made on first use. `flacTo` also writes its FLAC there (the render).
export async function mixedClip(ctx: Ctx, productionId: string, takes: TakeAudioRow[], opts: { flacTo?: string } = {}): Promise<MixedClip> {
  const hash = mixHash(takes.map((t) => t.id));
  const [cached] = await ctx.sql<MixedClip[]>`select hash, normalized_key, samples, stream_key from take_mixes where hash = ${hash}`;
  if (cached && (await ctx.storage.exists(cached.normalizedKey))) {
    if (opts.flacTo) await writeFile(opts.flacTo, await ctx.storage.get(cached.normalizedKey));
    return cached;
  }
  let running = inflight.get(hash);
  if (!running) {
    running = make(ctx, productionId, hash, takes).finally(() => inflight.delete(hash));
    inflight.set(hash, running);
  }
  const done = await running;
  if (opts.flacTo) await writeFile(opts.flacTo, await ctx.storage.get(done.normalizedKey));
  return done;
}

async function make(ctx: Ctx, productionId: string, hash: string, takes: TakeAudioRow[]): Promise<MixedClip> {
  const dir = await mkdtemp(path.join(tmpdir(), "offbooked-mix-"));
  try {
    const inputs: string[] = [];
    for (const take of takes) {
      const file = path.join(dir, `in-${take.id}.flac`);
      await normalizedTake(ctx, productionId, take, { flacTo: file });
      inputs.push(file);
    }
    const flac = path.join(dir, "mix.flac");
    const m4a = path.join(dir, "mix.m4a");
    const samples = await mixClips(inputs, path.join(dir, "mix.wav"), flac, m4a);
    const normalizedKey = `productions/${productionId}/mixes/${hash}.flac`;
    const streamKey = `productions/${productionId}/mixes/${hash}.m4a`;
    await Promise.all([ctx.storage.put(normalizedKey, await readFile(flac), "audio/flac"), ctx.storage.put(streamKey, await readFile(m4a), "audio/mp4")]);
    await ctx.sql`
      insert into take_mixes (hash, production_id, normalized_key, stream_key, samples)
      values (${hash}, ${productionId}, ${normalizedKey}, ${streamKey}, ${samples})
      on conflict (hash) do update set normalized_key = excluded.normalized_key, stream_key = excluded.stream_key, samples = excluded.samples`;
    return { hash, normalizedKey, samples, streamKey };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
