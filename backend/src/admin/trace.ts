import type { Sql } from "../db.ts";
import { parsePersonKey } from "./people.ts";

// One person's timeline, from what the app already stores. What it can't show, because nothing
// records it: listening to a run-through or a take, which parts someone picked and when (picks
// have no timestamp), who deleted a take, and a director's activity between sign-ins.

export type TraceKind =
  | "signed_up"
  | "beta_access"
  | "sign_in_link"
  | "signed_in"
  | "account_deleted"
  | "production_created"
  | "script_uploaded"
  | "script_read"
  | "script_failed"
  | "production_archived"
  | "content_deleted"
  | "render_requested"
  | "email_sent"
  | "joined_cast"
  | "started_recording"
  | "email_requested"
  | "email_verified"
  | "last_active"
  | "practice_run"
  | "recorded"
  | "takes_deleted";

export interface TraceEvent {
  at: string;
  kind: TraceKind;
  text: string;
  production: { id: string; title: string } | null;
}

export interface Trace {
  key: string;
  name: string | null;
  emails: string[];
  accounts: { id: string; email: string | null; signedUpAt: string; deletedAt: string | null }[];
  castRows: { id: string; name: string; production: { id: string; title: string }; joinedAt: string; lastActiveAt: string | null }[];
  events: TraceEvent[];
}

/** At most this many events come back, newest kept. */
export const TRACE_LIMIT = 2000;

const EMAIL_KINDS: Record<string, string> = {
  actor_done: "Emailed: a cast member finished their lines",
  cast_complete: "Emailed: the cast is complete",
  runthrough_ready: "Emailed: the listen-through is ready",
};

type Row = { at: Date; kind: TraceKind; text: string; productionId: string | null; productionTitle: string | null };

export async function personTrace(sql: Sql, key: string): Promise<Trace | null> {
  const who = parsePersonKey(key);
  const users = await sql<{ id: string; email: string; name: string | null; createdAt: Date; betaAccessAt: Date | null; deletedAt: Date | null }[]>`
    select id, email, name, created_at, beta_access_at, deleted_at from users
    where ${who.kind === "email" ? sql`deleted_at is null and lower(email) = ${who.email}` : who.kind === "user" ? sql`id = ${who.id}` : sql`false`}`;
  const userIds = users.map((u) => u.id);
  const actors = await sql<
    { id: string; name: string; email: string | null; productionId: string; title: string; createdAt: Date; lastActiveAt: Date | null }[]
  >`
    select a.id, a.name, case when a.email_verified_at is not null then nullif(btrim(a.email), '') end as email, a.production_id, p.title,
      a.created_at, a.last_active_at
    from actors a join productions p on p.id = a.production_id
    where ${
      who.kind === "email"
        ? sql`(a.director_user_id is null and a.email_verified_at is not null and lower(btrim(a.email)) = ${who.email}) or a.director_user_id = any(${userIds}::uuid[])`
        : who.kind === "user"
          ? sql`a.director_user_id = ${who.id}`
          : sql`a.id = ${who.id} and (a.director_user_id is null and (a.email_verified_at is null or nullif(btrim(a.email), '') is null))`
    }
    order by a.created_at`;
  const emailLinks = who.kind === "email" ? [who.email] : [];
  if (!users.length && !actors.length && !emailLinks.length) return null;
  const actorIds = actors.map((a) => a.id);

  const rows = await sql<Row[]>`
    with owned as (select id, title from productions where owner_id = any(${userIds}::uuid[])),
    mine as (select a.id, a.production_id, p.title from actors a join productions p on p.id = a.production_id where a.id = any(${actorIds}::uuid[])),
    tp as (
      select production_id, line_id, created_at, deleted_at from takes
      where recorded_by_user_id = any(${userIds}::uuid[]) or actor_id = any(${actorIds}::uuid[])
    )
    select * from (
      select u.created_at as at, 'signed_up' as kind, 'Created a director account' as text, null::uuid as production_id, null as production_title
        from users u where u.id = any(${userIds}::uuid[])
      union all
      select u.beta_access_at, 'beta_access', 'Got beta access', null, null from users u where u.id = any(${userIds}::uuid[]) and u.beta_access_at is not null
      union all
      select u.deleted_at, 'account_deleted', 'Deleted their account', null, null from users u where u.id = any(${userIds}::uuid[]) and u.deleted_at is not null
      union all
      select lt.created_at, 'sign_in_link', 'Asked for a sign-in link and never used it', null, null
        from login_tokens lt where lower(lt.email) = any(${emailLinks}::text[]) and lt.used_at is null
      union all
      select lt.used_at, 'signed_in', 'Signed in', null, null from login_tokens lt where lower(lt.email) = any(${emailLinks}::text[]) and lt.used_at is not null
      union all
      select p.created_at, 'production_created', 'Created a production', p.id, p.title from productions p where p.id in (select id from owned)
      union all
      select s.created_at, 'script_uploaded', 'Uploaded a script (' || s.source_kind || ')', o.id, o.title from scripts s join owned o on o.id = s.production_id
      union all
      select s.completed_at, case when s.status = 'ready' then 'script_read' else 'script_failed' end,
        case when s.status = 'ready' then 'The script was read' else 'The script could not be read' end, o.id, o.title
        from scripts s join owned o on o.id = s.production_id where s.completed_at is not null
      union all
      select p.archived_at, 'production_archived', 'Archived the production', p.id, p.title from productions p where p.id in (select id from owned) and p.archived_at is not null
      union all
      select p.content_deleted_at, 'content_deleted', 'Script and recordings deleted (retention)', p.id, p.title
        from productions p where p.id in (select id from owned) and p.content_deleted_at is not null
      union all
      select r.created_at, 'render_requested', 'Asked for the stitched render', o.id, o.title from renders r join owned o on o.id = r.production_id
      union all
      select n.sent_at, 'email_sent', n.kind, o.id, o.title from notifications n join owned o on o.id = n.production_id
        where n.sent_at is not null and n.kind in ('actor_done', 'cast_complete')
      union all
      select n.sent_at, 'email_sent', n.kind, m.production_id, m.title from notifications n join mine m on m.id = n.actor_id where n.sent_at is not null
      union all
      select a.created_at, 'joined_cast', case when a.director_user_id is null then 'Joined the cast' else 'Recorded as the director' end, m.production_id, m.title
        from actors a join mine m on m.id = a.id
      union all
      select a.opened_at, 'started_recording', 'Opened the recorder', m.production_id, m.title from actors a join mine m on m.id = a.id where a.opened_at is not null
      union all
      select a.pending_email_sent_at, 'email_requested', 'Asked for an email verification link', m.production_id, m.title
        from actors a join mine m on m.id = a.id where a.pending_email_sent_at is not null
      union all
      select a.email_verified_at, 'email_verified', 'Verified their email', m.production_id, m.title from actors a join mine m on m.id = a.id where a.email_verified_at is not null
      union all
      select a.last_active_at, 'last_active', 'Last used their cast link', m.production_id, m.title from actors a join mine m on m.id = a.id where a.last_active_at is not null
      union all
      select pr.created_at, 'practice_run', 'Finished a practice run', m.production_id, m.title from practice_runs pr join mine m on m.id = pr.actor_id
      union all
      -- Takes come one event per production per day, or a busy session would be hundreds of rows.
      select min(tp.created_at), 'recorded',
        'Recorded ' || count(*) || case when count(*) = 1 then ' take' else ' takes' end || ' of ' || count(distinct tp.line_id)
          || case when count(distinct tp.line_id) = 1 then ' line' else ' lines' end, p.id, p.title
        from tp join productions p on p.id = tp.production_id group by p.id, p.title, date_trunc('day', tp.created_at)
      union all
      select min(tp.deleted_at), 'takes_deleted', count(*) || case when count(*) = 1 then ' take' else ' takes' end || ' deleted', p.id, p.title
        from tp join productions p on p.id = tp.production_id where tp.deleted_at is not null group by p.id, p.title, date_trunc('day', tp.deleted_at)
    ) e
    order by at desc
    limit ${TRACE_LIMIT}`;

  const events = rows
    .map((r) => ({
      at: r.at.toISOString(),
      kind: r.kind,
      text: r.kind === "email_sent" ? (EMAIL_KINDS[r.text] ?? `Emailed: ${r.text}`) : r.text,
      production: r.productionId ? { id: r.productionId, title: r.productionTitle ?? "" } : null,
    }))
    .reverse();
  if (!users.length && !actors.length && !events.length) return null;

  const emails = [
    ...new Set([...users.filter((u) => !u.deletedAt).map((u) => u.email.toLowerCase()), ...actors.flatMap((a) => (a.email ? [a.email.toLowerCase()] : []))]),
  ];
  const name = users.find((u) => u.name)?.name ?? [...actors].reverse().find((a) => a.name.trim())?.name ?? null;
  return {
    key,
    name,
    emails: emails.length ? emails : emailLinks,
    accounts: users.map((u) => ({
      id: u.id,
      email: u.deletedAt ? null : u.email,
      signedUpAt: u.createdAt.toISOString(),
      deletedAt: u.deletedAt?.toISOString() ?? null,
    })),
    castRows: actors.map((a) => ({
      id: a.id,
      name: a.name,
      production: { id: a.productionId, title: a.title },
      joinedAt: a.createdAt.toISOString(),
      lastActiveAt: a.lastActiveAt?.toISOString() ?? null,
    })),
    events,
  };
}
