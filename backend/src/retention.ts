import type { Ctx } from "./context.ts";
import type { Sql } from "./db.ts";

// Content retention. A production's script content and recordings are deleted 7 days after its
// final performance (performance_ends_on), on that day at 12:00 UTC, so the date the director sees
// (contentDeletesOn) is the deletion day in every timezone from UTC-12 to UTC+11.
//
// DELETION IS IRREVERSIBLE. Storage objects under productions/<id>/ (takes, normalized FLACs,
// stream m4as, mixes, the uploaded script and renders) are deleted from the bucket, and the rows
// holding script text or recordings are deleted from the database. There is no undo and no backup
// beyond the database provider's own point-in-time restore window.
export const RETENTION_DAYS = 7;

const MAX_SLEEP_MS = 2 ** 31 - 1; // setTimeout's limit, about 24.8 days; longer waits chain timers
const CATCH_UP_EVERY_MS = 60_000;

// Productions due now, and milliseconds until the next one after them (null when none is pending).
// A production is due at 12:00 UTC, RETENTION_DAYS after performance_ends_on. Run as one
// statement (no sql fragments), so the idle test counts it as the one query it is.
export async function dueContent(sql: Sql): Promise<{ dueIds: string[]; nextMs: number | null }> {
  const [row] = await sql<{ dueIds: string[]; nextMs: number | null }[]>`
    with pending as (
      select p.id, (((p.performance_ends_on + ${RETENTION_DAYS}::int) + time '12:00') at time zone 'UTC') as due
      from productions p where p.content_deleted_at is null and p.performance_ends_on is not null)
    select
      coalesce((select array_agg(id) from pending where due <= now()), '{}') as due_ids,
      (select ceil(extract(epoch from min(due) - now()) * 1000)::float8 from pending where due > now()) as next_ms`;
  return { dueIds: row?.dueIds ?? [], nextMs: row?.nextMs ?? null };
}

// Deletes one production's script content and recordings, for good, and leaves the production row
// as an archived tombstone (title kept, content_deleted_at set). Cast and join links then return
// 410. TTS clips are shared across productions by hash and are kept. Actors stay, so their invite
// links still resolve to the wrapped production (410) rather than looking forged (401).
//
// Idempotent: storage first, then one transaction for the rows, then storage again for anything
// written while the rows went (an upload already past its auth check). A failure anywhere leaves
// content_deleted_at null, so the next pass picks the production up again. Returns null when the
// content was already deleted.
export async function deleteProductionContent(ctx: Ctx, productionId: string): Promise<{ objects: number } | null> {
  const { sql, storage } = ctx;
  // Archiving first stops new takes and parses: invite, join and upload routes refuse archived productions.
  const [p] = await sql`
    update productions set archived_at = coalesce(archived_at, now()) where id = ${productionId} and content_deleted_at is null returning id`;
  if (!p) return null;
  const prefix = `productions/${productionId}/`;
  let objects = await storage.deletePrefix(prefix);
  await sql.begin(async (tx) => {
    await tx`select 1 from productions where id = ${productionId} for update`;
    await tx`update lines set current_take_id = null where production_id = ${productionId} and current_take_id is not null`;
    await tx`delete from practice_runs where production_id = ${productionId}`;
    await tx`delete from take_mixes where production_id = ${productionId}`;
    await tx`delete from renders where production_id = ${productionId}`;
    await tx`delete from takes where production_id = ${productionId}`;
    await tx`delete from lines where production_id = ${productionId}`;
    await tx`delete from actor_characters where character_id in (select id from characters where production_id = ${productionId})`;
    await tx`delete from characters where production_id = ${productionId}`;
    await tx`delete from sections where production_id = ${productionId}`;
    await tx`delete from scripts where production_id = ${productionId}`;
    await tx`update productions set content_deleted_at = now(), script_status = 'none', script_error = null where id = ${productionId}`;
  });
  objects += await storage.deletePrefix(prefix);
  ctx.log.info({ productionId, objects }, "production content deleted (retention)");
  return { objects };
}

export interface RetentionWorker {
  kick(): void; // dates changed: look again now
  touch(): void; // a real request arrived: catch up if a deletion is overdue or the last pass failed
  stop(): Promise<void>;
  state(): { dueAt: number | null; failed: boolean };
}

// Event driven, never polled, so an idle server sends no queries and Neon can scale to zero:
// - one pass at startup (one query: what is due now, and when the next one is due),
// - a pass whenever a production's dates are created or changed (kick),
// - a timer for the next due time, chained in memory past setTimeout's 24.8-day limit without
//   touching the database,
// - catch-up alongside real requests (touch): if a timer was missed or a pass failed, the next
//   request (at most once a minute) runs a pass. Failed passes are never retried on a timer.
// `clock` and `maxSleepMs` are for tests.
export function startRetentionWorker(ctx: Ctx, opts: { clock?: () => number; maxSleepMs?: number } = {}): RetentionWorker {
  const clock = opts.clock ?? Date.now;
  const maxSleepMs = opts.maxSleepMs ?? MAX_SLEEP_MS;
  let running: Promise<void> | null = null;
  let kicked = false;
  let stopped = false;
  let failed = false;
  let dueAt: number | null = null;
  let lastCatchUp = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const arm = () => {
    clearTimeout(timer);
    if (stopped || dueAt === null) return;
    const wait = dueAt - clock();
    if (wait <= 0) return tick();
    timer = setTimeout(arm, Math.min(wait, maxSleepMs));
    timer.unref();
  };
  const pass = async () => {
    const { dueIds, nextMs } = await dueContent(ctx.sql);
    failed = false;
    for (const id of dueIds) {
      try {
        await deleteProductionContent(ctx, id);
      } catch (err) {
        failed = true;
        ctx.log.error({ err, productionId: id }, "deleting production content failed; retrying with the next request");
      }
    }
    dueAt = nextMs === null ? null : clock() + Math.max(nextMs, 1000);
    arm();
  };
  const tick = () => {
    if (stopped) return;
    if (running) {
      kicked = true;
      return;
    }
    clearTimeout(timer);
    running = pass()
      .catch((err) => {
        failed = true;
        ctx.log.error({ err }, "retention pass failed; retrying with the next request");
      })
      .finally(() => {
        running = null;
        if (kicked) {
          kicked = false;
          tick();
        }
      });
  };
  tick();
  return {
    kick: tick,
    touch: () => {
      if (stopped || running) return;
      const now = clock();
      if (!failed && (dueAt === null || now < dueAt)) return;
      if (now - lastCatchUp < CATCH_UP_EVERY_MS) return;
      lastCatchUp = now;
      tick();
    },
    stop: async () => {
      stopped = true;
      clearTimeout(timer);
      await running;
    },
    state: () => ({ dueAt, failed }),
  };
}
