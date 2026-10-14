import type { FastifyInstance } from "fastify";
import { ownedProduction, requireDirector, type Director } from "../auth.ts";
import type { Ctx } from "../context.ts";
import type { Sql, Tx } from "../db.ts";
import { badRequest, conflict, notFound } from "../errors.ts";
import { body, idOf, idParam, optionalString, requiredString } from "../input.ts";
import { charactersOf, characterView, lineView, sectionsOf, sectionView, type CharacterRow, type LineRow } from "../views.ts";

const MAX_LINE_CHARS = 10_000;
const KINDS = ["dialogue", "stage_direction", "heading"] as const;

async function ownedLine(sql: Sql, user: Director, lineId: string): Promise<LineRow & { productionId: string }> {
  const [line] = await sql<(LineRow & { productionId: string })[]>`
    select l.id, l.seq, l.section_id, l.kind, l.character_id, l.text, l.flagged, l.flag_reason, l.current_take_id, l.source_line, l.source_page, l.production_id
    from lines l join productions p on p.id = l.production_id
    where l.id = ${lineId} and p.owner_id = ${user.id}`;
  if (!line) throw notFound("Line not found.");
  return line;
}

async function ownedCharacter(sql: Sql, user: Director, characterId: string): Promise<CharacterRow & { productionId: string }> {
  const [c] = await sql<(CharacterRow & { productionId: string })[]>`
    select c.id, c.name, c.aliases, c.production_id, 0 as line_count
    from characters c join productions p on p.id = c.production_id
    where c.id = ${characterId} and p.owner_id = ${user.id}`;
  if (!c) throw notFound("Character not found.");
  return c;
}

const selectLine = (sql: Sql, id: string) =>
  sql<LineRow[]>`select id, seq, section_id, kind, character_id, text, flagged, flag_reason, current_take_id, source_line, source_page from lines where id = ${id}`.then((r) => lineView(r[0]!));

// Drops sections left empty by an edit and renumbers the rest in script order.
async function tidySections(sql: Tx, productionId: string): Promise<void> {
  await sql`delete from sections s where s.production_id = ${productionId} and not exists (select 1 from lines l where l.section_id = s.id)`;
  await sql`update sections s set seq = r.rn from (
              select id, row_number() over (order by seq) as rn from sections where production_id = ${productionId}) r
            where s.id = r.id and s.seq <> r.rn`;
}

const isUniqueViolation = (err: unknown) => (err as { code?: string }).code === "23505";

export function scriptRoutes(app: FastifyInstance, ctx: Ctx) {
  const { sql } = ctx;

  // Editing never touches takes: recordings stay attached to the line id.
  app.patch("/api/lines/:id", async (req) => {
    const user = await requireDirector(ctx, req);
    const line = await ownedLine(sql, user, idOf(req.params));
    const b = body(req.body);
    const kind = b.kind === undefined ? line.kind : (b.kind as LineRow["kind"]);
    if (!KINDS.includes(kind)) throw badRequest("kind must be dialogue, stage_direction or heading.");
    let characterId = line.characterId;
    if (b.characterId !== undefined) {
      characterId = b.characterId === null ? null : idParam(b.characterId);
      if (characterId) {
        const [c] = await sql`select 1 from characters where id = ${characterId} and production_id = ${line.productionId}`;
        if (!c) throw badRequest("That character isn't in this production.");
      }
    }
    if (kind !== "dialogue") characterId = null;
    if (kind === "dialogue" && !characterId) throw badRequest("Pick a character for a dialogue line.");
    const text = b.text === undefined ? line.text : requiredString(b, "text", MAX_LINE_CHARS);
    await sql`update lines set kind = ${kind}, character_id = ${characterId}, text = ${text}, flagged = false, flag_reason = null, updated_at = now()
              where id = ${line.id}`;
    return { line: await selectLine(sql, line.id) };
  });

  app.post("/api/lines/:id/split", async (req) => {
    const user = await requireDirector(ctx, req);
    const line = await ownedLine(sql, user, idOf(req.params));
    const at = body(req.body).at;
    if (!Number.isInteger(at) || (at as number) <= 0 || (at as number) >= line.text.length) throw badRequest("at must be a position inside the line's text.");
    const first = line.text.slice(0, at as number).trim();
    const second = line.text.slice(at as number).trim();
    if (!first || !second) throw badRequest("Both parts of a split need some text.");
    const newId = await sql.begin(async (tx) => {
      await tx`update lines set seq = seq + 1 where production_id = ${line.productionId} and seq > ${line.seq}`;
      await tx`update lines set text = ${first}, updated_at = now() where id = ${line.id}`;
      const [row] = await tx<{ id: string }[]>`
        insert into lines (production_id, section_id, seq, kind, character_id, text, source_line, source_page)
        values (${line.productionId}, ${line.sectionId}, ${line.seq + 1}, ${line.kind}, ${line.characterId}, ${second}, ${line.sourceLine}, ${line.sourcePage}) returning id`;
      return row!.id;
    });
    return { lines: [await selectLine(sql, line.id), await selectLine(sql, newId)] };
  });

  app.post("/api/lines/:id/merge-next", async (req) => {
    const user = await requireDirector(ctx, req);
    const line = await ownedLine(sql, user, idOf(req.params));
    await sql.begin(async (tx) => {
      const [next] = await tx<{ id: string; seq: number; text: string }[]>`
        select id, seq, text from lines where production_id = ${line.productionId} and seq = ${line.seq + 1} for update`;
      if (!next) throw badRequest("This is the last line, so there is nothing to merge.");
      const [recorded] = await tx`select 1 from takes where line_id = ${next.id} limit 1`;
      if (recorded) throw conflict("has_recordings", "The next line has recordings, so it can't be merged into this one.");
      await tx`update lines set text = ${`${line.text} ${next.text}`}, updated_at = now() where id = ${line.id}`;
      await tx`delete from lines where id = ${next.id}`;
      await tx`update lines set seq = seq - 1 where production_id = ${line.productionId} and seq > ${next.seq}`;
      await tidySections(tx, line.productionId);
    });
    return { line: await selectLine(sql, line.id) };
  });

  app.post("/api/lines/:id/section-break", async (req) => {
    const user = await requireDirector(ctx, req);
    const line = await ownedLine(sql, user, idOf(req.params));
    const b = body(req.body);
    const title = requiredString(b, "title", 120);
    const act = optionalString(b, "act", 40) ?? null;
    const scene = optionalString(b, "scene", 80) ?? null;
    await sql.begin(async (tx) => {
      const [section] = await tx<{ id: string; seq: number; firstSeq: number }[]>`
        select s.id, s.seq, (select min(seq) from lines where section_id = s.id) as first_seq from sections s where s.id = ${line.sectionId} for update`;
      if (section!.firstSeq === line.seq) {
        await tx`update sections set title = ${title}, act = ${act}, scene = ${scene} where id = ${section!.id}`;
        return;
      }
      await tx`update sections set seq = seq + 1 where production_id = ${line.productionId} and seq > ${section!.seq}`;
      const [created] = await tx<{ id: string }[]>`
        insert into sections (production_id, seq, act, scene, title) values (${line.productionId}, ${section!.seq + 1}, ${act}, ${scene}, ${title}) returning id`;
      await tx`update lines set section_id = ${created!.id} where section_id = ${section!.id} and seq >= ${line.seq}`;
    });
    return { sections: (await sectionsOf(sql, line.productionId)).map(sectionView) };
  });

  app.patch("/api/sections/:id", async (req) => {
    const user = await requireDirector(ctx, req);
    const title = requiredString(body(req.body), "title", 120);
    const [section] = await sql`
      update sections s set title = ${title} from productions p
      where s.id = ${idOf(req.params)} and p.id = s.production_id and p.owner_id = ${user.id}
      returning s.id, s.seq, s.act, s.scene, s.title`;
    if (!section) throw notFound("Section not found.");
    return { section };
  });

  app.post("/api/lines/:id/resolve", async (req) => {
    const user = await requireDirector(ctx, req);
    const line = await ownedLine(sql, user, idOf(req.params));
    await sql`update lines set flagged = false, flag_reason = null where id = ${line.id}`;
    return { line: await selectLine(sql, line.id) };
  });

  app.post("/api/productions/:id/characters", async (req) => {
    const user = await requireDirector(ctx, req);
    const p = await ownedProduction(ctx, user, idOf(req.params));
    const name = requiredString(body(req.body), "name", 80);
    try {
      const [c] = await sql<CharacterRow[]>`insert into characters (production_id, name) values (${p.id}, ${name}) returning id, name, aliases, 0 as line_count`;
      return { character: characterView(c!) };
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict("name_taken", `There is already a character called ${name}.`);
      throw err;
    }
  });

  app.patch("/api/characters/:id", async (req) => {
    const user = await requireDirector(ctx, req);
    const c = await ownedCharacter(sql, user, idOf(req.params));
    const name = requiredString(body(req.body), "name", 80);
    const aliases = name.toLowerCase() === c.name.toLowerCase() ? c.aliases : [...new Set([...c.aliases, c.name])].filter((a) => a.toLowerCase() !== name.toLowerCase());
    try {
      await sql`update characters set name = ${name}, aliases = ${aliases} where id = ${c.id}`;
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict("name_taken", `There is already a character called ${name}. Merge them instead.`);
      throw err;
    }
    const all = await charactersOf(sql, c.productionId);
    return { character: characterView(all.find((x) => x.id === c.id)!) };
  });

  app.post("/api/characters/:id/merge", async (req) => {
    const user = await requireDirector(ctx, req);
    const from = await ownedCharacter(sql, user, idOf(req.params));
    const intoId = idParam(body(req.body).intoId);
    if (intoId === from.id) throw badRequest("Pick a different character to merge into.");
    const into = await ownedCharacter(sql, user, intoId);
    if (into.productionId !== from.productionId) throw badRequest("Both characters must be in the same production.");
    await sql.begin(async (tx) => {
      const aliases = [...new Set([...into.aliases, from.name, ...from.aliases])].filter((a) => a.toLowerCase() !== into.name.toLowerCase());
      await tx`update lines set character_id = ${into.id}, updated_at = now() where character_id = ${from.id}`;
      await tx`update characters set aliases = ${aliases} where id = ${into.id}`;
      const [intoCast] = await tx`select 1 from actor_characters where character_id = ${into.id}`;
      if (intoCast) await tx`delete from actor_characters where character_id = ${from.id}`;
      else await tx`update actor_characters set character_id = ${into.id} where character_id = ${from.id}`;
      await tx`delete from characters where id = ${from.id}`;
    });
    return { characters: (await charactersOf(sql, from.productionId)).map(characterView) };
  });
}
