import type { Ctx } from "../context.ts";
import { resolveLineAudio } from "../linestream.ts";
import { TTS_PRIORITY } from "../tts/service.ts";
import { claimTrack, MAX_TRACK_LINES, TRACK_STRIDE, trackIdentity, trackLines, type LineRow, type TrackRequest } from "./track.ts";

// Listen tracks built ahead of time, so the first play starts on one file instead of line by line
// while its track is made (track.ts). Measured on production on 2026-10-30: a 300-line track of a
// recorded Measure for Measure took 55 to 125 s to build after play was pressed, most of it
// re-normalizing takes from an older pipeline, and until then the line-by-line player waited up to
// 21 s for some lines ("Getting the next line…").
//
// What is built: every stretch the player asks for (tracks start every TRACK_STRIDE lines) for the
// full read with no part, and for each cast member's default listen, "Pause, then read" on the
// parts they picked, for the stretches with their lines in them (the rest are the full read, as in
// the player). Other parts and modes are built when first asked for, as before. Each stretch's
// voices and takes are made ready first, outside the build queue, so a listener's own request
// never waits behind a slow synthesis.
//
// When: kicked by events only, never on a timer of its own. After a take, a deleted or restored
// take, or an edit to the script, the pass waits for TRACK_PREBUILD_QUIET_MS (2 minutes) without another (a cast recording
// hundreds of takes gets one pass when they pause, not one per take); once a script is read, a
// part is picked or someone opens the listen-through, it runs within SOON_MS. One production at a
// time per server; a kick during its pass runs it again afterwards. An idle server sends nothing.
//
// Cost: a 300-line track is about 25 to 35 minutes of 64 kb/s AAC, 12 to 17 MB. A recorded
// 800-line play with five cast members keeps about 4 full-read tracks and 3 or 4 per cast member
// current, ~20 tracks, ~300 MB; a take rebuilds only the stretches holding its line. Prebuilt
// tracks no listener was given are deleted as soon as they are out of date; ones a listener was
// given are left to the usual 12-hour prune, since a phone may still be playing them.

export type PrebuildReason = "take" | "edit" | "script" | "part" | "open";

/** How soon after a script is read, a part is picked or the listen-through is opened. */
export const SOON_MS = 5_000;
/** How long the pass waits for a stretch's voices and takes before building what it can. */
const PREPARE_WAIT_MS = 20 * 60_000;

interface State {
  /** Pending passes by production: when each is due, and whether a "soon" kick is in it. */
  due: Map<string, { at: number; soon: boolean; timer: ReturnType<typeof setTimeout> }>;
  /** Productions due now, in the order they came due, and the one running. */
  ready: string[];
  running: string | null;
  stopped: boolean;
}
const states = new WeakMap<Ctx, State>();
const stateOf = (ctx: Ctx) => {
  let s = states.get(ctx);
  if (!s) states.set(ctx, (s = { due: new Map(), ready: [], running: null, stopped: false }));
  return s;
};

/**
 * Something changed what this production's tracks hold, or someone is about to listen: build its
 * usual tracks after the wait for `reason`. Never queries; the pass runs from a timer this sets.
 */
export function prebuildTracks(ctx: Ctx, productionId: string, reason: PrebuildReason): void {
  if (!ctx.config.prebuildTracks) return;
  const s = stateOf(ctx);
  if (s.stopped) return;
  const soon = reason === "script" || reason === "part" || reason === "open";
  const now = Date.now();
  const pending = s.due.get(productionId);
  // A take or an edit pushes the pass back (they come in bursts), unless someone is about to listen.
  const at = soon
    ? Math.min(pending?.at ?? Infinity, now + Math.min(SOON_MS, ctx.config.prebuildQuietMs))
    : pending?.soon
      ? pending.at
      : now + ctx.config.prebuildQuietMs;
  if (pending && pending.at === at) return;
  if (pending) clearTimeout(pending.timer);
  const timer = setTimeout(
    () => {
      s.due.delete(productionId);
      if (!s.ready.includes(productionId)) s.ready.push(productionId);
      drain(ctx, s);
    },
    Math.max(0, at - now),
  );
  timer.unref?.();
  s.due.set(productionId, { at, soon: soon || Boolean(pending?.soon), timer });
}

/** Shutting down: no more passes start (one running finishes its current track). */
export function stopPrebuilding(ctx: Ctx): void {
  const s = stateOf(ctx);
  s.stopped = true;
  for (const p of s.due.values()) clearTimeout(p.timer);
  s.due.clear();
  s.ready.length = 0;
}

function drain(ctx: Ctx, s: State): void {
  if (s.running || s.stopped) return;
  const next = s.ready.shift();
  if (!next) return;
  s.running = next;
  ctx.jobs.run("prebuild listen tracks", async () => {
    try {
      await prebuildPass(ctx, next);
    } catch (err) {
      ctx.log.warn({ err, productionId: next }, "prebuilding listen tracks failed");
    } finally {
      s.running = null;
      drain(ctx, s);
    }
  });
}

/** One track the pass keeps current: a stretch, for one listen. */
export interface PlannedTrack {
  start: number;
  req: TrackRequest;
}

/**
 * The tracks to keep built for a play: each stretch the player asks for (web/src/player/
 * listenTrack.ts trackWindow, from a trackStart), read through, and for each cast member's parts
 * in "Pause, then read" where the stretch has their lines (a stretch without them is the full read,
 * as the player asks for it). By stretch, so the opening is ready first.
 */
export function plannedTracks(lines: Pick<LineRow, "id" | "kind" | "characterId" | "voiceIds">[], parts: string[][]): PlannedTrack[] {
  const out: PlannedTrack[] = [];
  const casts = [...new Map(parts.filter((p) => p.length).map((p) => [[...p].sort().join(","), new Set(p)])).values()];
  for (let start = 0; start < lines.length; start += TRACK_STRIDE) {
    const stretch = lines.slice(start, start + MAX_TRACK_LINES);
    const lineIds = stretch.map((l) => l.id);
    out.push({ start, req: { lineIds, mine: new Set(), mode: "read" } });
    for (const ids of casts) {
      // As the player's saysLine: the line's speaker, or one of the voices of a shared line.
      const mine = stretch.filter((l) => l.kind === "dialogue" && ((l.characterId && ids.has(l.characterId)) || (l.voiceIds ?? []).some((v) => ids.has(v))));
      if (mine.length) out.push({ start, req: { lineIds, mine: new Set(mine.map((l) => l.id)), mode: "pause" } });
    }
    if (start + MAX_TRACK_LINES >= lines.length) break;
  }
  return out;
}

/** Builds whichever of the production's usual tracks are missing, one stretch at a time, and drops the out-of-date ones. */
export async function prebuildPass(ctx: Ctx, productionId: string): Promise<{ built: number; kept: number; dropped: number }> {
  const started = Date.now();
  const [production] = await ctx.sql`
    select 1 from productions where id = ${productionId} and archived_at is null and content_deleted_at is null`;
  if (!production) return { built: 0, kept: 0, dropped: 0 };
  const lines = await trackLines(ctx, productionId);
  const parts = await ctx.sql<{ ids: string[] }[]>`
    select array_agg(ac.character_id) as ids from actor_characters ac join actors a on a.id = ac.actor_id
    where a.production_id = ${productionId} group by ac.actor_id`;
  const engine = ctx.tts ? await ctx.tts.engine() : null;
  const planned = plannedTracks(
    lines,
    parts.map((p) => p.ids),
  ).map((p) => ({ ...p, ...trackIdentity(lines, p.req, engine) }));
  const hashes = [...new Set(planned.map((p) => p.hash))];

  // The ones already built are kept (and spared the prune); the rest are built below.
  const kept = await ctx.sql<{ hash: string }[]>`
    update listen_tracks set prebuilt = true, used_at = now()
    where production_id = ${productionId} and hash = any(${hashes}) and status = 'ready'
    returning hash`;
  const have = new Set(kept.map((k) => k.hash));
  let built = 0;
  for (const start of [...new Set(planned.map((p) => p.start))]) {
    if (stateOf(ctx).stopped) break;
    const todo = planned.filter((p) => p.start === start && !have.has(p.hash));
    if (!todo.length) continue;
    // Voices and takes first, outside the build queue (the builds then only join files).
    await resolveLineAudio(ctx, productionId, todo[0]!.req.lineIds, { priority: TTS_PRIORITY.render, waitMs: PREPARE_WAIT_MS });
    const claims = [];
    for (const p of todo) {
      if (have.has(p.hash)) continue;
      have.add(p.hash);
      claims.push(await claimTrack(ctx, productionId, p.hash, p.lines, p.req, false));
    }
    await Promise.all(claims.map((c) => c.done));
    built += claims.filter((c) => c.done).length;
  }

  // Out of date: gone at once if no listener was given it, else left to the 12-hour prune.
  const dropped = await ctx.sql<{ storageKey: string | null }[]>`
    delete from listen_tracks
    where production_id = ${productionId} and prebuilt and served_at is null and status <> 'building' and not (hash = any(${hashes}))
    returning storage_key`;
  const keys = dropped.flatMap((d) => (d.storageKey ? [d.storageKey] : []));
  if (keys.length) await ctx.storage.deleteKeys(keys);
  await ctx.sql`update listen_tracks set prebuilt = false where production_id = ${productionId} and prebuilt and not (hash = any(${hashes}))`;
  ctx.log.info({ productionId, tracks: hashes.length, built, kept: kept.length, dropped: dropped.length, ms: Date.now() - started }, "listen tracks prebuilt");
  return { built, kept: kept.length, dropped: dropped.length };
}
