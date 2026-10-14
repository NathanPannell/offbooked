import type { FastifyInstance } from "fastify";
import { ownedProduction, requireDirector } from "../auth.ts";
import type { Ctx } from "../context.ts";
import { HttpError, badRequest, conflict } from "../errors.ts";
import { body, requiredString, uuidList } from "../input.ts";
import { inviteToken, inviteUrl, joinUrl, parseJoinToken } from "../invite.ts";
import { enforce, LIMITS } from "../ratelimit.ts";

interface JoinProduction {
  id: string;
  title: string;
  joinVersion: number;
  archivedAt: Date | null;
  scriptStatus: string;
  directorName: string | null;
}

// One link for the whole cast: open it, pick your characters, give a first name, start recording.
// A character someone has claimed (or the director has cast) can't be claimed again.
export function joinRoutes(app: FastifyInstance, ctx: Ctx) {
  const { sql, config } = ctx;

  const production = async (token: string, ip: string): Promise<JoinProduction> => {
    await enforce(sql, ctx.log, `join-ip:${ip}`, LIMITS.inviteIp);
    const parsed = parseJoinToken(config.inviteSecret, token);
    const invalid = () => new HttpError(404, "not_found", "This link isn't valid. Ask your director for the cast link.");
    if (!parsed) throw invalid();
    const [p] = await sql<JoinProduction[]>`
      select p.id, p.title, p.join_version, p.archived_at, p.script_status, u.name as director_name
      from productions p join users u on u.id = p.owner_id where p.id = ${parsed.productionId}`;
    if (!p || p.joinVersion !== parsed.version) throw invalid();
    const directorName = p.directorName || "Your director";
    if (p.archivedAt) throw new HttpError(410, "invite_expired", "This production has wrapped, so this link no longer works.", { directorName, productionTitle: p.title });
    if (p.scriptStatus !== "ready") throw new HttpError(409, "script_not_ready", "The script is still being prepared. Try this link again in a few minutes.", { directorName, productionTitle: p.title });
    return p;
  };

  const characters = (productionId: string) =>
    sql<{ id: string; name: string; lineCount: number; takenBy: string | null }[]>`
      select c.id, c.name,
        (select count(*)::int from lines l where l.character_id = c.id and l.kind = 'dialogue') as line_count,
        (select coalesce(a.first_name, split_part(a.name, ' ', 1)) from actor_characters ac join actors a on a.id = ac.actor_id where ac.character_id = c.id limit 1) as taken_by
      from characters c where c.production_id = ${productionId}
      order by line_count desc, lower(c.name)`;

  app.get("/api/join/:token", async (req) => {
    const p = await production((req.params as { token: string }).token, req.ip);
    return {
      production: { id: p.id, title: p.title, directorName: p.directorName || "Your director" },
      characters: (await characters(p.id)).filter((c) => c.lineCount > 0),
    };
  });

  app.post("/api/join/:token/claim", async (req) => {
    const p = await production((req.params as { token: string }).token, req.ip);
    await enforce(sql, ctx.log, `join-claim-ip:${req.ip}`, { limit: 30, windowSeconds: 3600 });
    const b = body(req.body);
    const firstName = requiredString(b, "firstName", 60);
    const characterIds = uuidList(b, "characterIds", true)!;
    if (!characterIds.length) throw badRequest("Pick at least one character.");
    const actorId = await sql.begin(async (tx) => {
      const rows = await tx<{ id: string; taken: boolean }[]>`
        select c.id, exists(select 1 from actor_characters ac where ac.character_id = c.id) as taken
        from characters c where c.production_id = ${p.id} and c.id = any(${characterIds}::uuid[]) for update`;
      if (rows.length !== characterIds.length) throw badRequest("Some of those characters aren't in this production.");
      if (rows.some((r) => r.taken)) throw conflict("character_taken", "Someone has just picked one of those characters. Choose again.");
      const [actor] = await tx<{ id: string }[]>`
        insert into actors (production_id, name, first_name, opened_at) values (${p.id}, ${firstName}, ${firstName}, now()) returning id`;
      await tx`insert into actor_characters ${tx(characterIds.map((characterId) => ({ actorId: actor!.id, characterId })))}`;
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
