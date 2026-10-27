import type { Sql } from "../db.ts";

// Headline figures for every account that has created a production. Offbooked has no billing yet
// (the beta is free), so the only "plan" there is to report is beta access.

export interface Creator {
  id: string;
  email: string | null;
  name: string | null;
  signedUpAt: Date;
  betaAccessAt: Date | null;
  deletedAt: Date | null;
  productions: number;
  activeProductions: number;
  castMembers: number;
  linesRecorded: number;
  takes: number;
  lastSignInAt: Date | null;
  lastActivity: Date;
}

export async function adminCreators(sql: Sql): Promise<Creator[]> {
  return sql<Creator[]>`
    with owned as (
      select owner_id, count(*)::int as productions,
        count(*) filter (where archived_at is null and content_deleted_at is null)::int as active_productions, max(created_at) as last_created
      from productions group by owner_id
    ), ca as (
      select p.owner_id, count(*)::int as cast_members, max(a.last_active_at) as last_cast_active
      from actors a join productions p on p.id = a.production_id where a.director_user_id is null group by p.owner_id
    ), tk as (
      select p.owner_id, count(*)::int as takes, count(distinct t.line_id)::int as lines_recorded, max(t.created_at) as last_take
      from takes t join productions p on p.id = t.production_id where t.deleted_at is null group by p.owner_id
    ), si as (
      -- Sessions go on sign-out; the used sign-in link stays, so both count.
      select u.id as user_id, greatest(max(s.created_at), max(lt.used_at)) as last_sign_in
      from users u left join sessions s on s.user_id = u.id left join login_tokens lt on lt.email = u.email and lt.used_at is not null
      where u.id in (select owner_id from owned) group by u.id
    )
    select u.id, case when u.deleted_at is null then u.email end as email, u.name, u.created_at as signed_up_at, u.beta_access_at, u.deleted_at,
      o.productions, o.active_productions, coalesce(ca.cast_members, 0) as cast_members, coalesce(tk.lines_recorded, 0) as lines_recorded,
      coalesce(tk.takes, 0) as takes, si.last_sign_in as last_sign_in_at,
      greatest(o.last_created, ca.last_cast_active, tk.last_take, si.last_sign_in, u.deleted_at) as last_activity
    from owned o
      join users u on u.id = o.owner_id
      left join ca on ca.owner_id = o.owner_id
      left join tk on tk.owner_id = o.owner_id
      left join si on si.user_id = o.owner_id
    order by last_activity desc, u.id`;
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export const creatorView = (c: Creator) => ({
  key: c.email ? `e:${c.email.toLowerCase()}` : `u:${c.id}`,
  email: c.email,
  name: c.name,
  signedUpAt: c.signedUpAt.toISOString(),
  deletedAt: iso(c.deletedAt),
  plan: { name: "Free beta", betaAccessAt: iso(c.betaAccessAt) },
  productions: c.productions,
  activeProductions: c.activeProductions,
  castMembers: c.castMembers,
  linesRecorded: c.linesRecorded,
  takes: c.takes,
  lastSignInAt: iso(c.lastSignInAt),
  lastActivity: c.lastActivity.toISOString(),
});
