import type { FastifyInstance } from "fastify";
import { ownedProduction, requireDirector, type Director } from "../auth.ts";
import type { Ctx } from "../context.ts";
import type { Sql, Tx } from "../db.ts";
import { badRequest, notFound } from "../errors.ts";
import { body, idOf, optionalEmail, optionalString, requiredString, uuidList } from "../input.ts";
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

  app.post("/api/cast/:actorId/nudged", async (req) => {
    const user = await requireDirector(ctx, req);
    const actor = await ownedActor(sql, user, idOf(req.params, "actorId"));
    await sql`update actors set nudged_at = now() where id = ${actor.id}`;
    return { member: await member(actor.productionId, actor.id) };
  });
}
