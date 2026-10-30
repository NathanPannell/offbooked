import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Ctx } from "../context.ts";
import { badRequest } from "../errors.ts";
import { body, uuidList } from "../input.ts";
import { resolveLineAudio } from "../linestream.ts";
import { RENDER_SETTINGS } from "../render/plan.ts";
import { ContentDeletedError, sweepIfDeleted } from "../retention.ts";
import { TTS_PRIORITY } from "../tts/service.ts";
import { decodeToPcm, encodeTrack } from "./encode.ts";
import { MY_LINE_MODES, planTrack, type MyLineMode, type TrackItem } from "./plan.ts";

// A listen track: a stretch of the listen-through joined into one .m4a for one listener's part and
// mode. The website's line-by-line player gives its <audio> element a new source for every line
// and every gap, and with the phone locked mobile browsers don't reliably start a new source, so
// playback stopped at the end of the clip that was playing; one long source keeps going. The
// player still starts line by line (at once) and moves onto the track at the next line once it is
// built; moving between lines within it is a seek.
//
// Built in-process on request, one at a time, from the same .m4a clips line-by-line playback
// serves (so nothing is synthesized or normalized twice), each cut or padded to its exact length,
// then encoded once. Cached by a hash of everything that goes into it.

export const TRACK_SETTINGS = { version: 1, bitrate: "64k" } as const;
/** The most lines one track covers (about 20 to 30 minutes of a play). */
export const MAX_TRACK_LINES = 300;
/** Signed track URLs last long enough for a long listen with pauses (the player keeps the first URL it plays). */
export const TRACK_URL_TTL_SECONDS = 6 * 3600;
/** How long a build waits for clips still being made before giving up (the player asks again later). */
const BUILD_WAIT_MS = 5 * 60_000;
/**
 * A failed build is not tried again sooner than this, however often it is asked for, so a broken
 * line can't keep the server (and the database) busy. The web player waits as long between tries.
 */
export const RETRY_FAILED_MS = 10 * 60_000;
/** Tracks nobody has asked for in this long are deleted (rows and files) when another is built. */
const PRUNE_AFTER_HOURS = 12;

const RATE = RENDER_SETTINGS.sampleRate;

export type TrackView = { status: "building" } | { status: "failed" } | { status: "ready"; url: string; durationMs: number; items: TrackItem[] };

export interface TrackRequest {
  lineIds: string[];
  mine: Set<string>;
  mode: MyLineMode;
  /** Lines after which "Skip to my cues" leaves lines out: the fast-forward sound plays before the next one. */
  skips: Set<string>;
}

export function trackRequest(raw: unknown): TrackRequest {
  const b = body(raw);
  const lineIds = [...new Set(uuidList(b, "lineIds", true)!.map((id) => id.toLowerCase()))];
  if (!lineIds.length) throw badRequest("lineIds must list at least one line.");
  if (lineIds.length > MAX_TRACK_LINES) throw badRequest(`lineIds can list at most ${MAX_TRACK_LINES} lines.`);
  const mine = new Set((uuidList(b, "mine", false) ?? []).map((id) => id.toLowerCase()));
  const mode = b.mode ?? "read";
  if (typeof mode !== "string" || !MY_LINE_MODES.includes(mode as MyLineMode)) throw badRequest('mode must be "read", "skip" or "pause".');
  const skips = new Set((uuidList(b, "skips", false) ?? []).map((id) => id.toLowerCase()));
  return { lineIds, mine, mode: mode as MyLineMode, skips };
}

interface LineRow {
  id: string;
  sectionId: string;
  kind: string;
  text: string;
  characterId: string | null;
  voiceIds: string[] | null;
  currentTakeId: string | null;
  takesAt: Date | null;
}

// Everything that changes what a line sounds like: its text, speaker, voices, current take and the
// newest change to any of its takes (a shared line plays its voices' takes), plus the settings.
async function identity(ctx: Ctx, productionId: string, req: TrackRequest): Promise<{ hash: string; lines: LineRow[] }> {
  const rows = await ctx.sql<LineRow[]>`
    select l.id, l.section_id, l.kind, l.text, l.character_id, l.voice_ids, l.current_take_id,
      (select max(greatest(t.created_at, coalesce(t.deleted_at, t.created_at))) from takes t where t.line_id = l.id) as takes_at
    from lines l
    where l.production_id = ${productionId} and l.kind in ('dialogue', 'stage_direction') and l.id = any(${req.lineIds}::uuid[])`;
  const byId = new Map(rows.map((r) => [r.id, r]));
  const lines = req.lineIds.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
  const engine = ctx.tts ? await ctx.tts.engine() : null;
  const h = createHash("sha256").update(JSON.stringify({ track: TRACK_SETTINGS, render: RENDER_SETTINGS, engine, mode: req.mode }));
  for (const l of lines) {
    h.update(
      `\n${l.id}|${l.sectionId}|${l.kind}|${req.mine.has(l.id) ? 1 : 0}${req.skips.has(l.id) ? "|skip" : ""}|${l.characterId ?? ""}|${(l.voiceIds ?? []).join(",")}|${l.currentTakeId ?? ""}|${l.takesAt?.toISOString() ?? ""}|${l.text}`,
    );
  }
  return { hash: h.digest("hex"), lines };
}

interface TrackRow {
  id: string;
  status: "building" | "ready" | "failed";
  storageKey: string | null;
  durationMs: number | null;
  items: TrackItem[] | null;
  updatedAt: Date;
}

// Builds in progress on this server, by row id, and the one-at-a-time chain they run on.
const building = new WeakMap<Ctx, Set<string>>();
const chains = new WeakMap<Ctx, Promise<void>>();
const inProgress = (ctx: Ctx) => {
  let set = building.get(ctx);
  if (!set) building.set(ctx, (set = new Set()));
  return set;
};

/**
 * The track for these lines, part and mode: ready (with its URL and items), still building (ask
 * again), or failed (the player keeps playing line by line). Starts a build when there is none.
 */
export async function listenTrack(ctx: Ctx, productionId: string, raw: unknown): Promise<{ track: TrackView }> {
  const req = trackRequest(raw);
  const { hash, lines } = await identity(ctx, productionId, req);
  if (!lines.length) throw badRequest("None of those lines can be played.");
  const [row] = await ctx.sql<TrackRow[]>`
    select id, status, storage_key, duration_ms, items, updated_at from listen_tracks where production_id = ${productionId} and hash = ${hash}`;
  if (row?.status === "ready" && row.storageKey && row.items) {
    await ctx.sql`update listen_tracks set used_at = now() where id = ${row.id}`;
    return {
      track: { status: "ready", url: await ctx.storage.signedUrl(row.storageKey, TRACK_URL_TTL_SECONDS), durationMs: row.durationMs ?? 0, items: row.items },
    };
  }
  if (row?.status === "building" && inProgress(ctx).has(row.id)) return { track: { status: "building" } };
  if (row?.status === "failed" && Date.now() - row.updatedAt.getTime() < RETRY_FAILED_MS) return { track: { status: "failed" } };
  // New, failed a while ago, or left "building" by a restart: (re)build it.
  const [claimed] = await ctx.sql<{ id: string }[]>`
    insert into listen_tracks (production_id, hash, status) values (${productionId}, ${hash}, 'building')
    on conflict (production_id, hash) do update set status = 'building', error = null, updated_at = now(), used_at = now()
      where listen_tracks.status <> 'ready'
    returning id`;
  if (!claimed) return listenTrack(ctx, productionId, raw); // finished meanwhile
  // Two first requests at once both claim the row: the second leaves the build to the first.
  if (inProgress(ctx).has(claimed.id)) return { track: { status: "building" } };
  inProgress(ctx).add(claimed.id);
  const run = (chains.get(ctx) ?? Promise.resolve()).then(() => buildTrack(ctx, productionId, claimed.id, hash, lines, req));
  chains.set(
    ctx,
    run.catch(() => undefined),
  );
  ctx.jobs.run("build a listen track", () => run);
  return { track: { status: "building" } };
}

async function buildTrack(ctx: Ctx, productionId: string, rowId: string, hash: string, lines: LineRow[], req: TrackRequest): Promise<void> {
  const started = Date.now();
  let workDir: string | undefined;
  let ready = false;
  try {
    workDir = await mkdtemp(path.join(tmpdir(), "offbooked-track-"));
    const dir = workDir;
    const audio = await resolveLineAudio(
      ctx,
      productionId,
      lines.map((l) => l.id),
      { priority: TTS_PRIORITY.render, waitMs: BUILD_WAIT_MS },
    );
    if (audio.some((a) => !a.ready)) throw new Error("Some lines were not ready in time");
    const byLine = new Map(audio.map((a) => [a.lineId, a]));
    const plan = planTrack(
      lines.flatMap((l) => (byLine.has(l.id) ? [{ lineId: l.id, sectionId: l.sectionId, text: l.text, audio: byLine.get(l.id)! }] : [])),
      req.mine,
      req.mode,
      req.skips,
    );
    const keys = [...new Set(plan.pieces.flatMap((p) => (p.kind === "clip" ? [p.key] : [])))];
    const pcm = new Map(keys.map((key, i) => [key, path.join(dir, `clip-${i}.pcm`)]));
    await eachLimit(keys, 4, async (key) => {
      const source = `${pcm.get(key)!}.m4a`;
      await writeFile(source, await ctx.storage.get(key));
      await decodeToPcm(source, pcm.get(key)!);
    });
    const out = path.join(dir, "track.m4a");
    await encodeTrack(plan.pieces, pcm, out, TRACK_SETTINGS.bitrate);
    const key = `productions/${productionId}/tracks/${hash}.m4a`;
    await ctx.storage.put(key, await readFile(out), "audio/mp4");
    if (await sweepIfDeleted(ctx, productionId)) throw new ContentDeletedError();
    const durationMs = Math.round((plan.totalSamples * 1000) / RATE);
    await ctx.sql`
      update listen_tracks set status = 'ready', storage_key = ${key}, duration_ms = ${durationMs}, items = ${ctx.sql.json(plan.items as never)},
        error = null, updated_at = now(), used_at = now()
      where id = ${rowId} and status = 'building'`;
    ready = true;
    ctx.log.info({ productionId, lines: lines.length, durationMs, ms: Date.now() - started }, "listen track ready");
  } catch (err) {
    ctx.log.warn({ err, productionId }, "listen track failed");
    await ctx.sql`
      update listen_tracks set status = 'failed', error = ${String((err as Error).message).slice(0, 500)}, updated_at = now()
      where id = ${rowId} and status = 'building'`;
  } finally {
    inProgress(ctx).delete(rowId);
    if (workDir) await rm(workDir, { recursive: true, force: true });
  }
  // Outside the build's try: a prune that fails mustn't mark the track just built as failed.
  if (ready) await pruneTracks(ctx, productionId).catch((err) => ctx.log.warn({ err, productionId }, "pruning listen tracks failed"));
}

/** Deletes this production's tracks nobody has asked for in a while, rows and files. */
export async function pruneTracks(ctx: Ctx, productionId: string): Promise<number> {
  const gone = await ctx.sql<{ storageKey: string | null }[]>`
    delete from listen_tracks where production_id = ${productionId} and used_at < now() - ${PRUNE_AFTER_HOURS} * interval '1 hour' and status <> 'building'
    returning storage_key`;
  const keys = gone.flatMap((g) => (g.storageKey ? [g.storageKey] : []));
  if (keys.length) await ctx.storage.deleteKeys(keys);
  return gone.length;
}

async function eachLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}
