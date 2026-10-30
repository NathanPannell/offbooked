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
// Built in-process, one at a time, from the same .m4a clips line-by-line playback serves (so
// nothing is synthesized or normalized twice), each cut or padded to its exact length, then encoded
// once. Cached by a hash of everything that goes into it. Built on request, and ahead of time for
// the usual listens (prebuild.ts); a listener's request goes before the ones built ahead.

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
export const PRUNE_AFTER_HOURS = 12;
/**
 * Tracks start every TRACK_STRIDE lines of the play, so the stretch a listener asks for is one built
 * ahead: a track from line 0, one from 260, one from 520… (the last one ends the play). Each holds
 * MAX_TRACK_LINES, so it overlaps the next by the 40 lines in which the player asks for the next one
 * (web/src/player/listenTrack.ts, trackStart; keep them in step).
 */
export const TRACK_STRIDE = 260;

/** Where the track for the line at `index` starts, in a play of `count` lines. */
export function trackStart(index: number, count: number): number {
  const last = Math.max(0, Math.ceil((count - MAX_TRACK_LINES) / TRACK_STRIDE)) * TRACK_STRIDE;
  return Math.min(Math.floor(Math.max(0, index) / TRACK_STRIDE) * TRACK_STRIDE, last);
}

const RATE = RENDER_SETTINGS.sampleRate;

export type TrackView = { status: "building" } | { status: "failed" } | { status: "ready"; url: string; durationMs: number; items: TrackItem[] };

export interface TrackRequest {
  lineIds: string[];
  mine: Set<string>;
  mode: MyLineMode;
}

export function trackRequest(raw: unknown): TrackRequest {
  const b = body(raw);
  const lineIds = [...new Set(uuidList(b, "lineIds", true)!.map((id) => id.toLowerCase()))];
  if (!lineIds.length) throw badRequest("lineIds must list at least one line.");
  if (lineIds.length > MAX_TRACK_LINES) throw badRequest(`lineIds can list at most ${MAX_TRACK_LINES} lines.`);
  const mine = new Set((uuidList(b, "mine", false) ?? []).map((id) => id.toLowerCase()));
  const mode = b.mode ?? "read";
  if (typeof mode !== "string" || !MY_LINE_MODES.includes(mode as MyLineMode)) throw badRequest('mode must be "read", "skip" or "pause".');
  return { lineIds, mine, mode: mode as MyLineMode };
}

export interface LineRow {
  id: string;
  sectionId: string;
  kind: string;
  text: string;
  characterId: string | null;
  voiceIds: string[] | null;
  currentTakeId: string | null;
  takesAt: Date | null;
}

/** A production's playable lines (all of them, in script order, or just `lineIds`) with what goes into a track's hash. */
export async function trackLines(ctx: Ctx, productionId: string, lineIds?: string[]): Promise<LineRow[]> {
  return ctx.sql<LineRow[]>`
    select l.id, l.section_id, l.kind, l.text, l.character_id, l.voice_ids, l.current_take_id,
      (select max(greatest(t.created_at, coalesce(t.deleted_at, t.created_at))) from takes t where t.line_id = l.id) as takes_at
    from lines l
    where l.production_id = ${productionId} and l.kind in ('dialogue', 'stage_direction')
      ${lineIds ? ctx.sql`and l.id = any(${lineIds}::uuid[])` : ctx.sql``}
    order by l.seq`;
}

// Everything that changes what a line sounds like: its text, speaker, voices, current take and the
// newest change to any of its takes (a shared line plays its voices' takes), plus the settings.
// `rows` may hold more lines than the request; the track has the requested ones, in its order.
export function trackIdentity(rows: LineRow[], req: TrackRequest, engine: string | null): { hash: string; lines: LineRow[] } {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const lines = req.lineIds.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
  const h = createHash("sha256").update(JSON.stringify({ track: TRACK_SETTINGS, render: RENDER_SETTINGS, engine, mode: req.mode }));
  for (const l of lines) {
    h.update(
      `\n${l.id}|${l.sectionId}|${l.kind}|${req.mine.has(l.id) ? 1 : 0}|${l.characterId ?? ""}|${(l.voiceIds ?? []).join(",")}|${l.currentTakeId ?? ""}|${l.takesAt?.toISOString() ?? ""}|${l.text}`,
    );
  }
  return { hash: h.digest("hex"), lines };
}

async function identity(ctx: Ctx, productionId: string, req: TrackRequest): Promise<{ hash: string; lines: LineRow[] }> {
  const rows = await trackLines(ctx, productionId, req.lineIds);
  return trackIdentity(rows, req, ctx.tts ? await ctx.tts.engine() : null);
}

interface TrackRow {
  id: string;
  status: "building" | "ready" | "failed";
  storageKey: string | null;
  durationMs: number | null;
  items: TrackItem[] | null;
  updatedAt: Date;
}

// Builds waiting or running on this server, by row id, and the queue they run from: one at a time,
// a listener's before the ones built ahead (prebuild.ts).
interface Build {
  urgent: boolean;
  done: Promise<void>;
  start: () => void;
}
const builds = new WeakMap<Ctx, { byRow: Map<string, Build>; waiting: Build[]; running: boolean }>();
const buildsOf = (ctx: Ctx) => {
  let b = builds.get(ctx);
  if (!b) builds.set(ctx, (b = { byRow: new Map(), waiting: [], running: false }));
  return b;
};

function enqueue(ctx: Ctx, rowId: string, urgent: boolean, run: () => Promise<void>): Promise<void> {
  const b = buildsOf(ctx);
  let start!: () => void;
  const started = new Promise<void>((resolve) => (start = resolve));
  const build: Build = { urgent, start, done: started.then(run).finally(() => b.byRow.delete(rowId)) };
  b.byRow.set(rowId, build);
  b.waiting.push(build);
  if (!b.running) {
    b.running = true;
    ctx.jobs.run("build listen tracks", async () => {
      try {
        while (b.waiting.length) {
          const i = b.waiting.findIndex((w) => w.urgent);
          const [next] = b.waiting.splice(Math.max(0, i), 1);
          next!.start();
          await next!.done.catch(() => undefined);
        }
      } finally {
        b.running = false;
      }
    });
  }
  return build.done;
}

/** A build of this row waiting or running here, if any; a listener's request moves a waiting one to the front. */
function queued(ctx: Ctx, rowId: string, urgent: boolean): Promise<void> | null {
  const build = buildsOf(ctx).byRow.get(rowId);
  if (!build) return null;
  if (urgent) build.urgent = true;
  return build.done;
}

/**
 * Finds the track, or starts its build when there is none. `urgent`: a listener asked, and it goes
 * first; otherwise it is built ahead (prebuild.ts) and marked `prebuilt`. `done` settles when a
 * build started or found here is over.
 */
export async function claimTrack(
  ctx: Ctx,
  productionId: string,
  hash: string,
  lines: LineRow[],
  req: TrackRequest,
  urgent: boolean,
): Promise<{ status: TrackView["status"]; row?: TrackRow; done?: Promise<void> }> {
  const [row] = await ctx.sql<TrackRow[]>`
    select id, status, storage_key, duration_ms, items, updated_at from listen_tracks where production_id = ${productionId} and hash = ${hash}`;
  if (row?.status === "ready" && row.storageKey && row.items) return { status: "ready", row };
  if (row?.status === "building") {
    const done = queued(ctx, row.id, urgent);
    if (done) return { status: "building", done };
  }
  if (row?.status === "failed" && Date.now() - row.updatedAt.getTime() < RETRY_FAILED_MS) return { status: "failed" };
  // New, failed a while ago, or left "building" by a restart: (re)build it.
  const [claimed] = await ctx.sql<{ id: string }[]>`
    insert into listen_tracks (production_id, hash, status, prebuilt) values (${productionId}, ${hash}, 'building', ${!urgent})
    on conflict (production_id, hash) do update set status = 'building', error = null, updated_at = now(), used_at = now(),
      prebuilt = listen_tracks.prebuilt or excluded.prebuilt
      where listen_tracks.status <> 'ready'
    returning id`;
  if (!claimed) return claimTrack(ctx, productionId, hash, lines, req, urgent); // finished meanwhile
  // Two first requests at once both claim the row: the second leaves the build to the first.
  const already = queued(ctx, claimed.id, urgent);
  if (already) return { status: "building", done: already };
  return { status: "building", done: enqueue(ctx, claimed.id, urgent, () => buildTrack(ctx, productionId, claimed.id, hash, lines, req)) };
}

/**
 * The track for these lines, part and mode: ready (with its URL and items), still building (ask
 * again), or failed (the player keeps playing line by line). Starts a build when there is none.
 */
export async function listenTrack(ctx: Ctx, productionId: string, raw: unknown): Promise<{ track: TrackView }> {
  const req = trackRequest(raw);
  const { hash, lines } = await identity(ctx, productionId, req);
  if (!lines.length) throw badRequest("None of those lines can be played.");
  const { status, row } = await claimTrack(ctx, productionId, hash, lines, req, true);
  if (status !== "ready" || !row) return { track: { status } as TrackView };
  // Gone meanwhile (an out-of-date prebuilt track nobody had been given): build it again.
  const [served] = await ctx.sql`
    update listen_tracks set used_at = now(), served_at = coalesce(served_at, now()) where id = ${row.id} returning id`;
  if (!served) return listenTrack(ctx, productionId, raw);
  return {
    track: { status: "ready", url: await ctx.storage.signedUrl(row.storageKey!, TRACK_URL_TTL_SECONDS), durationMs: row.durationMs ?? 0, items: row.items! },
  };
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
    if (workDir) await rm(workDir, { recursive: true, force: true });
  }
  // Outside the build's try: a prune that fails mustn't mark the track just built as failed.
  if (ready) await pruneTracks(ctx, productionId).catch((err) => ctx.log.warn({ err, productionId }, "pruning listen tracks failed"));
}

/**
 * Deletes this production's tracks nobody has asked for in a while, rows and files. Prebuilt ones
 * stay while they are current; the prebuild deletes or lets go of them once they aren't.
 */
export async function pruneTracks(ctx: Ctx, productionId: string): Promise<number> {
  const gone = await ctx.sql<{ storageKey: string | null }[]>`
    delete from listen_tracks
    where production_id = ${productionId} and used_at < now() - ${PRUNE_AFTER_HOURS} * interval '1 hour' and status <> 'building' and not prebuilt
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
