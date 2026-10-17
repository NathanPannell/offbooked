import type { FastifyInstance } from "fastify";
import { ownedProduction, requireDirector, type Director } from "../auth.ts";
import type { Ctx } from "../context.ts";
import type { Sql, Tx } from "../db.ts";
import { badRequest, conflict, notFound } from "../errors.ts";
import { isUuid } from "../crypto.ts";
import { body, idOf, optionalEmail, optionalString, requiredString, uuidList } from "../input.ts";
import { inviteToken, inviteUrl } from "../invite.ts";
import { inferInBackground } from "../shared.ts";
import { castMemberView, castRows } from "../views.ts";

async function ownedActor(sql: Sql, user: Director, actorId: string): Promise<{ id: string; productionId: string }> {
  const [a] = await sql<{ id: string; productionId: string }[]>`
    select a.id, a.production_id from actors a join productions p on p.id = a.production_id where a.id = ${actorId} and p.owner_id = ${user.id}`;
  if (!a) throw notFound("Cast member not found.");
  return a;
}

// One actor per character: assigning a character takes it away from whoever had it.
async function assignCharacters(tx: Tx, productionId: string, actorId: string, characterIds: string[]): Promise<void> {
  if (characterIds.length) {
    const found = await tx`select id from characters where production_id = ${productionId} and id = any(${characterIds}::uuid[])`;
    if (found.length !== characterIds.length) throw badRequest("Some of those characters aren't in this production.");
  }
  await tx`delete from actor_characters where actor_id = ${actorId}`;
  if (!characterIds.length) return;
  await tx`delete from actor_characters where character_id = any(${characterIds}::uuid[])`;
  await tx`insert into actor_characters ${tx(characterIds.map((characterId) => ({ actorId, characterId })))}`;
}

export function castRoutes(app: FastifyInstance, ctx: Ctx) {
  const { sql, config } = ctx;
  const member = async (productionId: string, actorId: string) => castMemberView(config, (await castRows(sql, { productionId, actorId }))[0]!);

  app.get("/api/productions/:id/cast", async (req) => {
    const user = await requireDirector(ctx, req);
    const p = await ownedProduction(ctx, user, idOf(req.params));
    const cast = await castRows(sql, { productionId: p.id });
    const uncast = await sql<{ id: string }[]>`
      select c.id from characters c where c.production_id = ${p.id}
        and not exists (select 1 from actor_characters ac where ac.character_id = c.id)
      order by lower(c.name)`;
    return { cast: cast.map((a) => castMemberView(config, a)), uncastCharacterIds: uncast.map((c) => c.id) };
  });

  app.post("/api/productions/:id/cast", async (req) => {
    const user = await requireDirector(ctx, req);
    const p = await ownedProduction(ctx, user, idOf(req.params));
    const b = body(req.body);
    const name = requiredString(b, "name", 80);
    const email = optionalEmail(b, "email") ?? null;
    const phone = optionalString(b, "phone", 40) ?? null;
    const characterIds = uuidList(b, "characterIds", true)!;
    const actorId = await sql.begin(async (tx) => {
      const [row] = await tx<{ id: string }[]>`insert into actors (production_id, name, email, phone) values (${p.id}, ${name}, ${email}, ${phone}) returning id`;
      await assignCharacters(tx, p.id, row!.id, characterIds);
      return row!.id;
    });
    return { member: await member(p.id, actorId) };
  });

  app.patch("/api/cast/:actorId", async (req) => {
    const user = await requireDirector(ctx, req);
    const actor = await ownedActor(sql, user, idOf(req.params, "actorId"));
    const b = body(req.body);
    const name = b.name === undefined ? undefined : requiredString(b, "name", 80);
    const email = optionalEmail(b, "email");
    const phone = optionalString(b, "phone", 40);
    const characterIds = uuidList(b, "characterIds", false);
    await sql.begin(async (tx) => {
      if (name !== undefined) await tx`update actors set name = ${name} where id = ${actor.id}`;
      if (email !== undefined) await tx`update actors set email = ${email} where id = ${actor.id}`;
      if (phone !== undefined) await tx`update actors set phone = ${phone} where id = ${actor.id}`;
      if (characterIds) await assignCharacters(tx, actor.productionId, actor.id, characterIds);
    });
    return { member: await member(actor.productionId, actor.id) };
  });

  app.post("/api/cast/:actorId/reset-link", async (req) => {
    const user = await requireDirector(ctx, req);
    const actor = await ownedActor(sql, user, idOf(req.params, "actorId"));
    await sql`update actors set token_version = token_version + 1 where id = ${actor.id}`;
    return { member: await member(actor.productionId, actor.id) };
  });

  // The call sheet: every speaking character, who has taken it (first name) and how many of its
  // lines the cast has recorded, shared lines included. Groups ("ALL", "ANGELO, ESCALUS") aren't
  // parts, so they aren't listed. Stand-in takes and TTS don't count.
  app.get("/api/productions/:id/call-sheet", async (req) => {
    const user = await requireDirector(ctx, req);
    const p = await ownedProduction(ctx, user, idOf(req.params));
    const rows = await sql<{ id: string; name: string; lineCount: number; linesRecorded: number; sharedLines: number; takenBy: string | null; actorId: string | null; mine: boolean }[]>`
      select c.id, c.name,
        (select count(*)::int from line_voices lv where lv.character_id = c.id) as line_count,
        (select count(*)::int from line_voices lv where lv.character_id = c.id
          and voice_take(lv.line_id, lv.shared, lv.character_id, true) is not null) as lines_recorded,
        (select count(*)::int from line_voices lv where lv.character_id = c.id and lv.shared) as shared_lines,
        coalesce(a.first_name, split_part(a.name, ' ', 1)) as taken_by,
        a.id as actor_id,
        coalesce(a.director_user_id = ${user.id}, false) as mine
      from characters c
        left join actor_characters ac on ac.character_id = c.id
        left join actors a on a.id = ac.actor_id
      where c.production_id = ${p.id} and not c.is_group
      order by line_count desc, lower(c.name)`;
    // Lines said by ALL only have the whole-scene guess until Claude has read who is on stage.
    inferInBackground(ctx, p.id);
    return { characters: rows.filter((c) => c.lineCount > 0) };
  });

  // The director records a part themselves, in the same recording flow the cast uses. They get
  // one cast member per production (created on first use) that takes the character; a character
  // someone else has taken is refused.
  app.post("/api/productions/:id/record-as", async (req) => {
    const user = await requireDirector(ctx, req);
    const p = await ownedProduction(ctx, user, idOf(req.params));
    const b = body(req.body);
    if (!isUuid(b.characterId)) throw badRequest("Pick a character.");
    const characterId = b.characterId.toLowerCase();
    const name = user.name?.trim() || "Director";
    const firstName = name.split(/\s+/)[0]!;
    const actor = await sql.begin(async (tx) => {
      const [character] = await tx<{ id: string; ownerId: string | null }[]>`
        select c.id, ac.actor_id as owner_id from characters c left join actor_characters ac on ac.character_id = c.id
        where c.id = ${characterId} and c.production_id = ${p.id} for update of c`;
      if (!character) throw notFound("Character not found.");
      await tx`
        insert into actors (production_id, name, first_name, opened_at, director_user_id)
        values (${p.id}, ${name}, ${firstName}, now(), ${user.id})
        on conflict (production_id, director_user_id) where director_user_id is not null do nothing`;
      const [mine] = await tx<{ id: string; tokenVersion: number }[]>`
        select id, token_version from actors where production_id = ${p.id} and director_user_id = ${user.id}`;
      if (character.ownerId && character.ownerId !== mine!.id) {
        throw conflict("character_taken", "Someone in the cast has already taken that part.");
      }
      if (!character.ownerId) await tx`insert into actor_characters (actor_id, character_id) values (${mine!.id}, ${character.id})`;
      return mine!;
    });
    return {
      inviteToken: inviteToken(config.inviteSecret, actor.id, actor.tokenVersion),
      inviteUrl: inviteUrl(config.appUrl, config.inviteSecret, actor.id, actor.tokenVersion),
    };
  });

  // Takes a part away from whoever has it. Their takes stay and keep playing; the part is free again
  // for someone else to pick up and record the rest (or record over).
  app.post("/api/productions/:id/characters/:characterId/unassign", async (req, reply) => {
    const user = await requireDirector(ctx, req);
    const p = await ownedProduction(ctx, user, idOf(req.params));
    const characterId = idOf(req.params, "characterId");
    const [c] = await sql`select 1 from characters where id = ${characterId} and production_id = ${p.id}`;
    if (!c) throw notFound("Character not found.");
    await sql`delete from actor_characters where character_id = ${characterId}`;
    return reply.code(204).send();
  });

  app.post("/api/cast/:actorId/nudged", async (req) => {
    const user = await requireDirector(ctx, req);
    const actor = await ownedActor(sql, user, idOf(req.params, "actorId"));
    await sql`update actors set nudged_at = now() where id = ${actor.id}`;
    return { member: await member(actor.productionId, actor.id) };
  });
}
