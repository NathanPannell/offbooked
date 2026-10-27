import type { FastifyRequest } from "fastify";
import { isAdminEmail, recordAdminView } from "./admin/access.ts";
import type { Config } from "./config.ts";
import type { Ctx } from "./context.ts";
import { sha256 } from "./crypto.ts";
import { HttpError, notFound, productionDeleted, unauthorized } from "./errors.ts";
import { inviteExpiresAt, parseInviteToken } from "./invite.ts";
import { castFacingName } from "./names.ts";
import { enforce, LIMITS } from "./ratelimit.ts";
import { productionRows, type ProductionRow } from "./views.ts";

export interface Director {
  id: string;
  email: string;
  name: string | null;
  /** May set up productions: entered the beta access code (src/beta.ts), or had an account before the beta gate. */
  betaAccess: boolean;
  /** In ADMIN_EMAILS: may open the admin area and view any production (read only). */
  admin: boolean;
}

/** An account row from the database with `admin` worked out from ADMIN_EMAILS. */
export const withAdmin = (config: Config, user: Omit<Director, "admin">): Director => ({ ...user, admin: isAdminEmail(config, user.email) });

export const SESSION_DAYS = 30;

function credential(req: FastifyRequest, scheme: "Bearer" | "Invite"): string | null {
  const header = req.headers.authorization;
  if (!header) return null;
  const [given, value] = header.split(/\s+/, 2);
  return given?.toLowerCase() === scheme.toLowerCase() && value ? value : null;
}

export async function requireDirector(ctx: Ctx, req: FastifyRequest): Promise<Director> {
  const token = credential(req, "Bearer");
  if (!token) throw unauthorized("Sign in to continue.");
  const [user] = await ctx.sql<Omit<Director, "admin">[]>`
    select u.id, u.email, u.name, u.beta_access_at is not null as beta_access from sessions s join users u on u.id = s.user_id
    where s.token_hash = ${sha256(token)} and s.expires_at > now() and u.deleted_at is null`;
  if (!user) throw unauthorized("Your session has ended. Sign in again.");
  return withAdmin(ctx.config, user);
}

// Every /api/admin route starts here. Anyone who isn't an admin, signed in or not, gets the same
// 404 as a route that doesn't exist, so the admin area isn't advertised.
export async function requireAdmin(ctx: Ctx, req: FastifyRequest): Promise<Director> {
  const user = await requireDirector(ctx, req).catch(() => null);
  if (!user?.admin) throw notFound("Not found.");
  return user;
}

const adminReadOnly = () => new HttpError(403, "admin_read_only", "You're viewing this production as an admin, so it's read only.");

// For changes: archived productions stay changeable by their owner; other people's productions are
// 404, except to an admin, who can see them (viewableProduction) but not change them.
export async function ownedProduction(ctx: Ctx, user: Director, productionId: string): Promise<ProductionRow> {
  const [p] = await productionRows(ctx.sql, { ownerId: user.id, id: productionId, includeArchived: true });
  if (p) return p;
  if (user.admin && (await productionRows(ctx.sql, { ownerId: null, id: productionId, includeArchived: true })).length) throw adminReadOnly();
  throw notFound("Production not found.");
}

// For reading: the owner's production, or, for an admin, anyone's, exactly as its owner sees it
// (`access: "admin"`). Each admin view of someone else's production is recorded in admin_audit.
export async function viewableProduction(ctx: Ctx, user: Director, productionId: string): Promise<ProductionRow> {
  const [own] = await productionRows(ctx.sql, { ownerId: user.id, id: productionId, includeArchived: true });
  if (own) return { ...own, access: "owner" };
  if (user.admin) {
    const [p] = await productionRows(ctx.sql, { ownerId: null, id: productionId, includeArchived: true });
    if (p) {
      await recordAdminView(ctx.sql, user.id, "view_production", { productionId: p.id });
      return { ...p, access: "admin" };
    }
  }
  throw notFound("Production not found.");
}

export interface ActorSession {
  // `email` is the verified address only; `pendingEmail` is waiting for its verification link.
  actor: { id: string; name: string; firstName: string | null; email: string | null; pendingEmail: string | null; tokenVersion: number; createdAt: Date };
  production: { id: string; title: string; performanceEndsOn: string | null; directorName: string };
  characterIds: string[];
}

// The invite token is the actor's only credential. Unknown or forged tokens are 401; tokens that
// were real but are now expired, reset or archived are 410 with enough context for a friendly page.
export async function requireActor(ctx: Ctx, req: FastifyRequest): Promise<ActorSession> {
  const token = credential(req, "Invite");
  const parsed = token ? parseInviteToken(ctx.config.inviteSecret, token) : null;
  await enforce(ctx.sql, ctx.log, `invite-ip:${req.ip}`, LIMITS.inviteIp);
  if (!parsed) throw unauthorized("This link doesn't work. Ask your director for the cast link.");
  const [row] = await ctx.sql<
    {
      id: string;
      name: string;
      firstName: string | null;
      email: string | null;
      pendingEmail: string | null;
      tokenVersion: number;
      createdAt: Date;
      productionId: string;
      title: string;
      performanceEndsOn: string | null;
      archivedAt: Date | null;
      directorName: string | null;
      directorEmail: string;
      ownerDeleted: boolean;
    }[]
  >`
    select a.id, a.name, a.first_name, case when a.email_verified_at is not null then nullif(btrim(a.email), '') end as email,
      a.pending_email, a.token_version, a.created_at, p.id as production_id, p.title,
      p.performance_ends_on::text as performance_ends_on, p.archived_at, u.name as director_name,
      u.email as director_email, u.deleted_at is not null as owner_deleted
    from actors a join productions p on p.id = a.production_id join users u on u.id = p.owner_id
    where a.id = ${parsed.actorId}`;
  if (!row) throw unauthorized("This link doesn't work. Ask your director for the cast link.");
  if (row.ownerDeleted) throw productionDeleted();
  const directorName = castFacingName(row.directorName, row.directorEmail);
  const gone = (message: string) => new HttpError(410, "invite_expired", message, { directorName, productionTitle: row.title });
  if (row.archivedAt) throw gone("This production has wrapped, so this link no longer works.");
  if (parsed.tokenVersion !== row.tokenVersion) throw gone("This link was replaced with a new one. Ask your director for the latest link.");
  if (inviteExpiresAt(row.performanceEndsOn, row.createdAt) < new Date()) throw gone("This link has expired. Ask your director for a new one.");
  await enforce(ctx.sql, ctx.log, `invite:${row.id}`, LIMITS.inviteActor);
  const chars = await ctx.sql<{ characterId: string }[]>`select character_id from actor_characters where actor_id = ${row.id}`;
  await ctx.sql`update actors set last_active_at = now() where id = ${row.id}`;
  return {
    actor: {
      id: row.id,
      name: row.name,
      firstName: row.firstName,
      email: row.email,
      pendingEmail: row.pendingEmail,
      tokenVersion: row.tokenVersion,
      createdAt: row.createdAt,
    },
    production: { id: row.productionId, title: row.title, performanceEndsOn: row.performanceEndsOn, directorName },
    characterIds: chars.map((c) => c.characterId),
  };
}
