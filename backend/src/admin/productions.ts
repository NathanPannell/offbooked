import type { Sql } from "../db.ts";

// Every production, newest activity first, for the admin list. Each count is one grouped pass over
// its table (takes by takes_production_idx), not a subquery per production.

export interface AdminProduction {
  id: string;
  title: string;
  createdAt: Date;
  archivedAt: Date | null;
  contentDeletedAt: Date | null;
  scriptStatus: string;
  performanceEndsOn: string | null;
  ownerId: string;
  ownerEmail: string | null;
  ownerName: string | null;
  linesTotal: number;
  linesRecorded: number;
  takes: number;
  castMembers: number;
  lastActivity: Date;
}

export const ADMIN_LIST_LIMIT = 500;

// ILIKE treats % and _ as wildcards; a search for "50%" means the characters.
const likePattern = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

export async function adminProductions(sql: Sql, q?: string): Promise<AdminProduction[]> {
  const search = q?.trim() ? likePattern(q.trim()) : null;
  return sql<AdminProduction[]>`
    with lt as (
      select production_id, count(*)::int as lines_total from lines where kind = 'dialogue' group by production_id
    ), tk as (
      select production_id, count(*) filter (where deleted_at is null)::int as takes,
        count(distinct line_id) filter (where deleted_at is null)::int as lines_recorded, max(created_at) as last_take
      from takes group by production_id
    ), ca as (
      select production_id, count(*) filter (where director_user_id is null)::int as cast_members, max(last_active_at) as last_cast_active
      from actors group by production_id
    )
    select p.id, p.title, p.created_at, p.archived_at, p.content_deleted_at, p.script_status, p.performance_ends_on::text as performance_ends_on,
      u.id as owner_id, case when u.deleted_at is null then u.email end as owner_email, u.name as owner_name,
      coalesce(lt.lines_total, 0) as lines_total, coalesce(tk.lines_recorded, 0) as lines_recorded, coalesce(tk.takes, 0) as takes,
      coalesce(ca.cast_members, 0) as cast_members, greatest(p.created_at, tk.last_take, ca.last_cast_active) as last_activity
    from productions p
      join users u on u.id = p.owner_id
      left join lt on lt.production_id = p.id
      left join tk on tk.production_id = p.id
      left join ca on ca.production_id = p.id
    ${search ? sql`where p.title ilike ${search} or u.email ilike ${search} or u.name ilike ${search}` : sql``}
    order by last_activity desc, p.id
    limit ${ADMIN_LIST_LIMIT}`;
}

export const adminProductionView = (p: AdminProduction) => ({
  id: p.id,
  title: p.title,
  createdAt: p.createdAt.toISOString(),
  archived: Boolean(p.archivedAt),
  contentDeleted: Boolean(p.contentDeletedAt),
  scriptStatus: p.scriptStatus,
  performanceEndsOn: p.performanceEndsOn,
  owner: { id: p.ownerId, email: p.ownerEmail, name: p.ownerName, key: p.ownerEmail ? `e:${p.ownerEmail.toLowerCase()}` : `u:${p.ownerId}` },
  linesTotal: p.linesTotal,
  linesRecorded: p.linesRecorded,
  takes: p.takes,
  castMembers: p.castMembers,
  lastActivity: p.lastActivity.toISOString(),
});
