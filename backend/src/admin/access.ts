import type { Config } from "../config.ts";
import type { Sql } from "../db.ts";

// The admin area: accounts whose email is in ADMIN_EMAILS may see every production (read only)
// and the figures in routes/admin.ts. The gate is requireAdmin in auth.ts; this file holds what it
// and the routes share. Nothing here runs on a timer: every query answers a request.

export const isAdminEmail = (config: Config, email: string) => config.adminEmails.includes(email.trim().toLowerCase());

export type AdminAction = "view_production" | "view_person";

/** How long one admin looking at one thing counts as a single view in the audit log. */
export const AUDIT_WINDOW_MINUTES = 10;

// One row per admin, action and subject per AUDIT_WINDOW_MINUTES (a run-through fetches each line's
// audio, and each of those requests checks access). Uses admin_audit_admin_idx.
export async function recordAdminView(sql: Sql, adminUserId: string, action: AdminAction, target: { productionId?: string; subject?: string }): Promise<void> {
  const productionId = target.productionId ?? null;
  const subject = target.subject ?? null;
  await sql`
    insert into admin_audit (admin_user_id, action, production_id, subject)
    select ${adminUserId}, ${action}, ${productionId}, ${subject}
    where not exists (
      select 1 from admin_audit
      where admin_user_id = ${adminUserId} and action = ${action}
        and production_id is not distinct from ${productionId}::uuid and subject is not distinct from ${subject}::text
        and created_at > now() - ${AUDIT_WINDOW_MINUTES} * interval '1 minute')`;
}

export interface AuditEntry {
  id: string;
  createdAt: Date;
  action: AdminAction;
  adminEmail: string;
  productionId: string | null;
  productionTitle: string | null;
  subject: string | null;
}

/** The newest audit rows (admin_audit_recent_idx), optionally for one production. */
export async function auditLog(sql: Sql, opts: { productionId?: string; limit?: number } = {}): Promise<AuditEntry[]> {
  return sql<AuditEntry[]>`
    select aa.id, aa.created_at, aa.action, u.email as admin_email, aa.production_id, p.title as production_title, aa.subject
    from admin_audit aa join users u on u.id = aa.admin_user_id left join productions p on p.id = aa.production_id
    ${opts.productionId ? sql`where aa.production_id = ${opts.productionId}` : sql``}
    order by aa.created_at desc
    limit ${opts.limit ?? 200}`;
}

export const auditView = (a: AuditEntry) => ({
  id: a.id,
  at: a.createdAt.toISOString(),
  action: a.action,
  admin: a.adminEmail,
  production: a.productionId ? { id: a.productionId, title: a.productionTitle ?? "" } : null,
  subject: a.subject,
});
