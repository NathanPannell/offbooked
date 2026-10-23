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
// 410. TTS clips are shared across productions by hash and are kept. Actor rows stay, so their invite
// links still resolve to the wrapped production (410) rather than looking forged (401); the names and
// phones of cast members who verified no email are cleared.
//
// Idempotent: storage first, then one transaction for the rows, then storage again for anything
// written while the rows went (an upload already past its auth check). A failure anywhere leaves
// content_deleted_at null, so the next pass picks the production up again. Returns null when the
// content was already deleted.
//
// Only a production that is due is touched (checked here, not just by the caller), and once it is
// due its final date can't change (routes/productions.ts), so a stale list can't delete a show whose
// date just moved. Writers that finish after the last sweep (an upload, normalization, mix, render
// or parse) call sweepIfDeleted after their own writes, so nothing written late survives.
export async function deleteProductionContent(ctx: Ctx, productionId: string): Promise<{ objects: number } | null> {
  // Archiving first turns the cast's invite and join links away (410) before anything goes.
  const [p] = await ctx.sql`
    update productions p set archived_at = coalesce(archived_at, now())
    where p.id = ${productionId} and p.content_deleted_at is null and p.performance_ends_on is not null
      and (((p.performance_ends_on + ${RETENTION_DAYS}::int) + time '12:00') at time zone 'UTC') <= now()
    returning p.id`;
  if (!p) return null;
  const objects = await purgeProduction(ctx, productionId, "retention");
  return { objects };
}

// Deletes everything a director's account holds, for good, when they delete it (DELETE /api/me):
// each of their productions is archived and purged like a production past its retention date, and
// more besides, since nobody is left to want it: the title and every cast member's details go,
// verified emails included. The users row stays as a tombstone with no email or name (productions
// keep their owner_id), its sessions and sign-in links are deleted, and signing in again with the
// same address makes a new, empty account. A failure part-way leaves the account signed in, so the
// director can simply ask again: every step is safe to repeat.
export async function deleteAccount(ctx: Ctx, userId: string): Promise<{ productions: number; objects: number }> {
  const owned = await ctx.sql<{ id: string }[]>`
    update productions set archived_at = coalesce(archived_at, now()) where owner_id = ${userId} returning id`;
  let objects = 0;
  for (const { id } of owned) objects += await purgeProduction(ctx, id, "account");
  await ctx.sql.begin(async (tx) => {
    const [user] = await tx<{ email: string }[]>`select email from users where id = ${userId} for update`;
    if (user) await tx`delete from login_tokens where email = ${user.email}`;
    await tx`delete from sessions where user_id = ${userId}`;
    await tx`update users set email = 'deleted-' || id || '@deleted.invalid', name = null, deleted_at = coalesce(deleted_at, now()) where id = ${userId}`;
  });
  ctx.log.info({ userId, productions: owned.length, objects }, "account deleted");
  return { productions: owned.length, objects };
}

// The deletion itself, for a production already archived. `retention` keeps the cast details tied
// to a verified email (and a director's own cast row, tied to their account) and the title;
// `account` clears those too. Returns how many storage objects went.
async function purgeProduction(ctx: Ctx, productionId: string, reason: "retention" | "account"): Promise<number> {
  const { sql, storage } = ctx;
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
    if (reason === "retention") {
      // Cast details go too unless they're tied to a verified email: someone who verified an email (to
      // hear when the play is ready) keeps their name with it; everyone else's name, phone and any
      // unverified address are cleared. Addresses still waiting for their link go for everyone. The
      // rows stay so their invite links still answer 410. A director's own cast row is tied to their
      // account's email and is kept.
      await tx`
        update actors set name = '', first_name = null, phone = null, email = null, email_verified_at = null
        where production_id = ${productionId} and director_user_id is null
          and (email_verified_at is null or coalesce(btrim(email), '') = '')`;
    } else {
      await tx`
        update actors set name = '', first_name = null, phone = null, email = null, email_verified_at = null, director_user_id = null
        where production_id = ${productionId}`;
      await tx`update notifications set recipient = null where production_id = ${productionId}`;
      await tx`update productions set title = '' where id = ${productionId}`;
    }
    await tx`update actors set pending_email = null, pending_email_sent_at = null where production_id = ${productionId} and pending_email is not null`;
    await tx`update productions set content_deleted_at = coalesce(content_deleted_at, now()), script_status = 'none', script_error = null where id = ${productionId}`;
  });
  objects += await storage.deletePrefix(prefix);
  ctx.log.info({ productionId, objects }, `production content deleted (${reason})`);
  return objects;
}

// Writers call this after putting objects under productions/<id>/ and before recording them. If the
// production's content was deleted meanwhile (after deleteProductionContent's last sweep), the
// folder is swept again and it returns true, so the writer stops.
export async function sweepIfDeleted(ctx: Ctx, productionId: string): Promise<boolean> {
  const [deleted] = await ctx.sql`select 1 from productions where id = ${productionId} and content_deleted_at is not null`;
  if (!deleted) return false;
  await ctx.sql`delete from take_mixes where production_id = ${productionId}`;
  await ctx.storage.deletePrefix(`productions/${productionId}/`);
  ctx.log.warn({ productionId }, "swept a write that finished after the production's content was deleted");
  return true;
}

export class ContentDeletedError extends Error {
  constructor() {
    super("This production's script and recordings were deleted after its final performance.");
  }
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
