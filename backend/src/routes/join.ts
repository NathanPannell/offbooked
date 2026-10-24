import type { FastifyInstance } from "fastify";
import { ownedProduction, requireDirector } from "../auth.ts";
import type { Ctx } from "../context.ts";
import type { Sql } from "../db.ts";
import { HttpError, badRequest, productionDeleted } from "../errors.ts";
import { body, optionalString, requiredString, uuidList } from "../input.ts";
import { inviteToken, inviteUrl, joinUrl, parseJoinToken } from "../invite.ts";
import { castFacingName } from "../names.ts";
import { enforce, LIMITS } from "../ratelimit.ts";
import { topRecorders, type TopRecorder } from "../recorders.ts";

export interface PartCard {
  id: string;
  name: string;
  lineCount: number;
  linesRecorded: number; // by anyone
  linesNeeded: number; // lineCount - linesRecorded: still played by the computer voice
  topRecorder: TopRecorder | null;
}

// Every part with lines (no groups), biggest first: the join page's cards and "pick up more lines".
export async function partCards(sql: Sql, productionId: string): Promise<PartCard[]> {
  const [rows, top] = await Promise.all([
    sql<Omit<PartCard, "linesNeeded" | "topRecorder">[]>`
      select c.id, c.name,
        (select count(*)::int from line_voices lv where lv.character_id = c.id) as line_count,
        (select count(*)::int from line_voices lv where lv.character_id = c.id
          and voice_take(lv.line_id, lv.shared, lv.character_id) is not null) as lines_recorded
      from characters c where c.production_id = ${productionId} and not c.is_group
      order by line_count desc, lower(c.name)`,
    topRecorders(sql, productionId),
  ]);
  return rows.filter((c) => c.lineCount > 0).map((c) => ({ ...c, linesNeeded: c.lineCount - c.linesRecorded, topRecorder: top.get(c.id) ?? null }));
}

interface JoinProduction {
  id: string;
  title: string;
  joinVersion: number;
  archivedAt: Date | null;
  scriptStatus: string;
  directorName: string;
}

// One link for the whole cast: open it, pick your characters, give a first name, start recording.
// Parts aren't owned: anyone can pick any part, even one others have picked or recorded.
export function joinRoutes(app: FastifyInstance, ctx: Ctx) {
  const { sql, config } = ctx;

  const production = async (token: string, ip: string): Promise<JoinProduction> => {
    await enforce(sql, ctx.log, `join-ip:${ip}`, LIMITS.inviteIp);
    const parsed = parseJoinToken(config.inviteSecret, token);
    const invalid = () => new HttpError(404, "not_found", "This link isn't valid. Ask your director for the cast link.");
    if (!parsed) throw invalid();
    const [row] = await sql<(Omit<JoinProduction, "directorName"> & { directorName: string | null; directorEmail: string; ownerDeleted: boolean })[]>`
      select p.id, p.title, p.join_version, p.archived_at, p.script_status, u.name as director_name, u.email as director_email,
        u.deleted_at is not null as owner_deleted
      from productions p join users u on u.id = p.owner_id where p.id = ${parsed.productionId}`;
    if (!row || row.joinVersion !== parsed.version) throw invalid();
    if (row.ownerDeleted) throw productionDeleted();
    const { directorEmail, ...rest } = row;
    const directorName = castFacingName(row.directorName, directorEmail);
    const p = { ...rest, directorName };
    if (p.archivedAt)
      throw new HttpError(410, "invite_expired", "This production has wrapped, so this link no longer works.", { directorName, productionTitle: p.title });
    if (p.scriptStatus !== "ready")
      throw new HttpError(409, "script_not_ready", "The script is still being prepared. Try this link again in a few minutes.", {
        directorName,
        productionTitle: p.title,
      });
    return p;
  };

  app.get("/api/join/:token", async (req) => {
    const p = await production((req.params as { token: string }).token, req.ip);
    return { production: { id: p.id, title: p.title, directorName: p.directorName }, characters: await partCards(sql, p.id) };
  });

  app.post("/api/join/:token/claim", async (req) => {
    const p = await production((req.params as { token: string }).token, req.ip);
    await enforce(sql, ctx.log, `join-claim-ip:${req.ip}`, { limit: 30, windowSeconds: 3600 });
    const b = body(req.body);
    // `listen`: someone who only wants to listen through joins with no part and, if they like, no name.
    const listen = b.listen === true;
    const firstName = listen ? (optionalString(b, "firstName", 60) ?? "") : requiredString(b, "firstName", 60);
    const characterIds = listen ? [] : uuidList(b, "characterIds", true)!;
    if (!listen && !characterIds.length) throw badRequest("Pick at least one character.");
    const actorId = await sql.begin(async (tx) => {
      const rows = await tx`
        select c.id from characters c where c.production_id = ${p.id} and not c.is_group and c.id = any(${characterIds}::uuid[])`;
      if (rows.length !== characterIds.length) throw badRequest("Some of those characters aren't in this production.");
      const [actor] = await tx<{ id: string }[]>`
        insert into actors (production_id, name, first_name, opened_at) values (${p.id}, ${firstName}, ${firstName}, now()) returning id`;
      if (characterIds.length) await tx`insert into actor_characters ${tx(characterIds.map((characterId) => ({ actorId: actor!.id, characterId })))}`;
      return actor!.id;
    });
    return { inviteToken: inviteToken(config.inviteSecret, actorId, 1), inviteUrl: inviteUrl(config.appUrl, config.inviteSecret, actorId, 1) };
  });

  app.get("/api/productions/:id/join-link", async (req) => {
    const user = await requireDirector(ctx, req);
    const p = await ownedProduction(ctx, user, (req.params as { id: string }).id);
    const [row] = await sql<{ joinVersion: number }[]>`select join_version from productions where id = ${p.id}`;
    return { joinUrl: joinUrl(config.appUrl, config.inviteSecret, p.id, row!.joinVersion) };
  });

  app.post("/api/productions/:id/join-link/reset", async (req) => {
    const user = await requireDirector(ctx, req);
    const p = await ownedProduction(ctx, user, (req.params as { id: string }).id);
    const [row] = await sql<{ joinVersion: number }[]>`update productions set join_version = join_version + 1 where id = ${p.id} returning join_version`;
    return { joinUrl: joinUrl(config.appUrl, config.inviteSecret, p.id, row!.joinVersion) };
  });
}
