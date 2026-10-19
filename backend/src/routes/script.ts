import type { FastifyInstance } from "fastify";
import { ownedProduction, requireDirector, type Director } from "../auth.ts";
import type { Ctx } from "../context.ts";
import type { Sql, Tx } from "../db.ts";
import { badRequest, conflict, notFound } from "../errors.ts";
import { classifyFlagReason, FLAG_CODES, isFlagCode, type FlagCode } from "../parse/flags.ts";
import { body, idOf, idParam, optionalString, requiredString, uuidList } from "../input.ts";
import { afterCastChange } from "../shared.ts";
import { charactersOf, characterView, lineView, sectionsOf, sectionView, type CharacterRow, type LineRow, type SectionRow } from "../views.ts";

const MAX_LINE_CHARS = 10_000;
const KINDS = ["dialogue", "stage_direction", "heading"] as const;

async function ownedLine(sql: Sql, user: Director, lineId: string): Promise<LineRow & { productionId: string }> {
  const [line] = await sql<(LineRow & { productionId: string })[]>`
    select l.id, l.seq, l.section_id, l.kind, l.character_id, l.text, l.flagged, l.flag_code, l.flag_reason, l.current_take_id, l.source_line, l.source_page, l.voice_ids, l.production_id
    from lines l join productions p on p.id = l.production_id
    where l.id = ${lineId} and p.owner_id = ${user.id}`;
  if (!line) throw notFound("Line not found.");
  return line;
}

async function ownedCharacter(sql: Sql, user: Director, characterId: string): Promise<CharacterRow & { productionId: string }> {
  const [c] = await sql<(CharacterRow & { productionId: string })[]>`
    select c.id, c.name, c.aliases, c.production_id, c.is_group, c.everyone, c.member_ids, 0 as line_count
    from characters c join productions p on p.id = c.production_id
    where c.id = ${characterId} and p.owner_id = ${user.id}`;
  if (!c) throw notFound("Character not found.");
  return c;
}

const selectLine = (sql: Sql, id: string) =>
  sql<
    LineRow[]
  >`select id, seq, section_id, kind, character_id, text, flagged, flag_code, flag_reason, current_take_id, source_line, source_page, voice_ids from lines where id = ${id}`.then(
    (r) => lineView(r[0]!),
  );

// Drops sections left empty by an edit and renumbers the rest in script order.
async function tidySections(sql: Tx, productionId: string): Promise<void> {
  await sql`delete from sections s where s.production_id = ${productionId} and not exists (select 1 from lines l where l.section_id = s.id)`;
  await sql`update sections s set seq = r.rn from (
              select id, row_number() over (order by seq) as rn from sections where production_id = ${productionId}) r
            where s.id = r.id and s.seq <> r.rn`;
}

// A flag sent back by undo (split's `second`, an insert, or a PATCH that restores an edit). A client
// that sends no code gets the reason's nearest one, else the usual one for the kind.
function flagFrom(b: Record<string, unknown>, kind: LineRow["kind"]): { flagged: boolean; flagCode: FlagCode | null; flagReason: string | null } {
  const flagged = b.flagged === true;
  if (!flagged) return { flagged, flagCode: null, flagReason: null };
  if (b.flagCode !== undefined && b.flagCode !== null && !isFlagCode(b.flagCode)) throw badRequest(`flagCode must be one of ${FLAG_CODES.join(", ")}.`);
  const flagReason = optionalString(b, "flagReason", 500) ?? null;
  const kindCode: FlagCode = kind === "dialogue" ? "speaker" : kind === "heading" ? "heading" : "direction";
  const flagCode = isFlagCode(b.flagCode) ? b.flagCode : (flagReason && classifyFlagReason(flagReason)) || kindCode;
  return { flagged, flagCode, flagReason };
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
    // Several people say it: `voiceIds` lists them. Names make a group character ("ANGELO, ESCALUS");
    // on an ALL line the pick replaces Claude's guess of who is on stage (null puts the guess back).
    let voices: { ids: string[] | null; source: "director" | null } | null = null;
    const voiceIds = b.voiceIds === null ? null : uuidList(b, "voiceIds", false);
    if (kind === "dialogue" && b.voiceIds !== undefined) {
      const picked = voiceIds ? [...new Set(voiceIds.map((id) => id.toLowerCase()))] : null;
      const known = picked?.length
        ? await sql<{ id: string; name: string; isGroup: boolean }[]>`
            select id, name, is_group from characters where production_id = ${line.productionId} and id = any(${picked}::uuid[])`
        : [];
      if (picked && (known.length !== picked.length || known.some((c) => c.isGroup))) throw badRequest("Pick characters from this production.");
      const [current] = characterId ? await sql<{ everyone: boolean }[]>`select everyone from characters where id = ${characterId}` : [];
      if (current?.everyone) voices = picked && picked.length ? { ids: picked, source: "director" } : { ids: null, source: null };
      else if (picked?.length === 1) characterId = picked[0]!;
      else if (picked && picked.length > 1) {
        characterId = await groupCharacter(sql, line.productionId, picked.map((id) => known.find((c) => c.id === id)!.name).join(", "));
      }
    }
    let text = b.text === undefined ? line.text : requiredString(b, "text", MAX_LINE_CHARS);
    if (kind === "dialogue" && !characterId) {
      // Turning a direction or heading into dialogue in one tap: take the speaker from a cue at
      // the start of the text, else the speaker of the dialogue line before it.
      const guess = await guessSpeaker(sql, line.productionId, line.seq, text);
      if (!guess) throw badRequest("Pick a character for a dialogue line.");
      characterId = guess.characterId;
      text = guess.text;
    }
    // An edit settles the line; an undo of an edit sends `flagged` (and its code) back.
    const flag = b.flagged === undefined ? { flagged: false, flagCode: null, flagReason: null } : flagFrom(b, kind);
    await sql`update lines set kind = ${kind}, character_id = ${characterId}, text = ${text}, flagged = ${flag.flagged}, flag_code = ${flag.flagCode},
              flag_reason = ${flag.flagReason}, updated_at = now() where id = ${line.id}`;
    if (voices) await sql`update lines set voice_ids = ${voices.ids}::uuid[], voices_source = ${voices.source} where id = ${line.id}`;
    await afterCastChange(ctx, line.productionId);
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
    // Undoing a join passes back what the lower line was, so it returns exactly as it was.
    const was = body(req.body).second === undefined ? {} : body(body(req.body).second);
    const kind = was.kind === undefined ? line.kind : (was.kind as LineRow["kind"]);
    if (!KINDS.includes(kind)) throw badRequest("kind must be dialogue, stage_direction or heading.");
    let characterId = was.characterId === undefined ? line.characterId : was.characterId === null ? null : idParam(was.characterId);
    if (kind !== "dialogue") characterId = null;
    if (characterId && characterId !== line.characterId) {
      const [c] = await sql`select 1 from characters where id = ${characterId} and production_id = ${line.productionId}`;
      if (!c) throw badRequest("That character isn't in this production.");
    }
    if (kind === "dialogue" && !characterId) throw badRequest("Pick a character for a dialogue line.");
    const { flagged, flagCode, flagReason } = flagFrom(was, kind);
    const sourceLine = Number.isInteger(was.sourceLine) ? (was.sourceLine as number) : line.sourceLine;
    const sourcePage = Number.isInteger(was.sourcePage) ? (was.sourcePage as number) : line.sourcePage;
    const newId = await sql.begin(async (tx) => {
      await tx`update lines set seq = seq + 1 where production_id = ${line.productionId} and seq > ${line.seq}`;
      await tx`update lines set text = ${first}, updated_at = now() where id = ${line.id}`;
      const [row] = await tx<{ id: string }[]>`
        insert into lines (production_id, section_id, seq, kind, character_id, text, flagged, flag_code, flag_reason, source_line, source_page)
        values (${line.productionId}, ${line.sectionId}, ${line.seq + 1}, ${kind}, ${characterId}, ${second}, ${flagged}, ${flagCode}, ${flagReason}, ${sourceLine}, ${sourcePage}) returning id`;
      return row!.id;
    });
    await afterCastChange(ctx, line.productionId);
    return { lines: [await selectLine(sql, line.id), await selectLine(sql, newId)] };
  });

  // Joins two neighbouring lines into the upper one, which keeps its id, kind and speaker. The
  // lower line goes away, so it must not have recordings.
  const join = async (productionId: string, upperSeq: number): Promise<string> =>
    sql.begin(async (tx) => {
      const pair = await tx<{ id: string; seq: number; text: string }[]>`
        select id, seq, text from lines where production_id = ${productionId} and seq in (${upperSeq}, ${upperSeq + 1}) order by seq for update`;
      const [upper, lower] = pair;
      if (!upper || !lower) throw badRequest("There is no line on that side to join with.");
      const [recorded] = await tx`select 1 from takes where line_id = ${lower.id} limit 1`;
      if (recorded) throw conflict("has_recordings", "The lower line has recordings, so it can't be joined into the one above.");
      await tx`update lines set text = ${`${upper.text}\n${lower.text}`}, flagged = false, flag_code = null, flag_reason = null, updated_at = now() where id = ${upper.id}`;
      await tx`delete from lines where id = ${lower.id}`;
      await tx`update lines set seq = seq - 1 where production_id = ${productionId} and seq > ${lower.seq}`;
      await tidySections(tx, productionId);
      return upper.id;
    });

  app.post("/api/lines/:id/merge-next", async (req) => {
    const user = await requireDirector(ctx, req);
    const line = await ownedLine(sql, user, idOf(req.params));
    const id = await join(line.productionId, line.seq);
    await afterCastChange(ctx, line.productionId);
    return { line: await selectLine(sql, id) };
  });

  app.post("/api/lines/:id/merge-previous", async (req) => {
    const user = await requireDirector(ctx, req);
    const line = await ownedLine(sql, user, idOf(req.params));
    if (line.seq <= 1) throw badRequest("This is the first line, so there is nothing above to join with.");
    const id = await join(line.productionId, line.seq - 1);
    await afterCastChange(ctx, line.productionId);
    return { line: await selectLine(sql, id) };
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
    await afterCastChange(ctx, line.productionId);
    return { sections: (await sectionsOf(sql, line.productionId)).map(sectionView) };
  });

  // Deletes a line that has no recordings. The answer carries what undo needs: the line as it was,
  // the line it sat after, and its scene when that scene went away with it.
  app.delete("/api/lines/:id", async (req) => {
    const user = await requireDirector(ctx, req);
    const line = await ownedLine(sql, user, idOf(req.params));
    const result = await sql.begin(async (tx) => {
      const [locked] = await tx`select 1 from lines where id = ${line.id} for update`;
      if (!locked) throw notFound("Line not found.");
      const [recorded] = await tx`select 1 from takes where line_id = ${line.id} limit 1`;
      if (recorded) throw conflict("has_recordings", "This line has recordings, so it can't be deleted.");
      const [before] = await tx<
        { id: string }[]
      >`select id from lines where production_id = ${line.productionId} and seq < ${line.seq} order by seq desc limit 1`;
      const [section] = await tx<SectionRow[]>`select id, seq, act, scene, title from sections where id = ${line.sectionId}`;
      await tx`delete from lines where id = ${line.id}`;
      await tx`update lines set seq = seq - 1 where production_id = ${line.productionId} and seq > ${line.seq}`;
      const [still] = await tx`select 1 from lines where section_id = ${line.sectionId} limit 1`;
      await tidySections(tx, line.productionId);
      return {
        line: lineView(line),
        afterLineId: before?.id ?? null,
        removedSection: still ? null : sectionView(section!),
      };
    });
    await afterCastChange(ctx, line.productionId);
    return result;
  });

  // Puts a line back after `afterLineId` (null: at the very start), in `sectionId`, or in a new
  // scene (`newSection`) when the deleted line's scene went away with it. Undo for DELETE.
  app.post("/api/productions/:id/lines", async (req) => {
    const user = await requireDirector(ctx, req);
    const p = await ownedProduction(ctx, user, idOf(req.params));
    const b = body(req.body);
    const kind = b.kind as LineRow["kind"];
    if (!KINDS.includes(kind)) throw badRequest("kind must be dialogue, stage_direction or heading.");
    const text = requiredString(b, "text", MAX_LINE_CHARS);
    let characterId = kind === "dialogue" && b.characterId != null ? idParam(b.characterId) : null;
    if (characterId) {
      const [c] = await sql`select 1 from characters where id = ${characterId} and production_id = ${p.id}`;
      if (!c) throw badRequest("That character isn't in this production.");
    }
    if (kind === "dialogue" && !characterId) {
      const guess = await guessSpeaker(sql, p.id, Number.MAX_SAFE_INTEGER, text);
      if (!guess) throw badRequest("Pick a character for a dialogue line.");
      characterId = guess.characterId;
    }
    const { flagged, flagCode, flagReason } = flagFrom(b, kind);
    const sourceLine = Number.isInteger(b.sourceLine) ? (b.sourceLine as number) : null;
    const sourcePage = Number.isInteger(b.sourcePage) ? (b.sourcePage as number) : null;
    const afterId = b.afterLineId == null ? null : idParam(b.afterLineId);
    const sectionId = b.sectionId == null ? null : idParam(b.sectionId);
    const fresh = b.newSection == null ? null : body(b.newSection);

    const newId = await sql.begin(async (tx) => {
      // Lock the production's lines so two inserts can't take the same place.
      await tx`select id from lines where production_id = ${p.id} for update`;
      let afterSeq = 0;
      let afterSection: { id: string; seq: number } | null = null;
      if (afterId) {
        const [after] = await tx<{ seq: number; sectionId: string; sectionSeq: number }[]>`
          select l.seq, l.section_id, s.seq as section_seq from lines l join sections s on s.id = l.section_id
          where l.id = ${afterId} and l.production_id = ${p.id}`;
        if (!after) throw badRequest("The line to insert after isn't in this production.");
        afterSeq = after.seq;
        afterSection = { id: after.sectionId, seq: after.sectionSeq };
      }
      const [next] = await tx<{ sectionId: string }[]>`select section_id from lines where production_id = ${p.id} and seq = ${afterSeq + 1}`;

      let targetSection: string;
      if (fresh) {
        // A new scene can only start at a scene boundary.
        if (next && afterSection && next.sectionId === afterSection.id) throw badRequest("A new scene can only go between two scenes.");
        const title = requiredString(fresh, "title", 120);
        const act = optionalString(fresh, "act", 40) ?? null;
        const scene = optionalString(fresh, "scene", 80) ?? null;
        const seq = afterSection ? afterSection.seq + 1 : 1;
        await tx`update sections set seq = seq + 1 where production_id = ${p.id} and seq >= ${seq}`;
        const [created] = await tx<{ id: string }[]>`
          insert into sections (production_id, seq, act, scene, title) values (${p.id}, ${seq}, ${act}, ${scene}, ${title}) returning id`;
        targetSection = created!.id;
      } else if (sectionId) {
        // Keep scenes in order: the line must sit next to a line of its scene.
        if (sectionId !== afterSection?.id && sectionId !== next?.sectionId) throw badRequest("That scene isn't next to this place in the script.");
        targetSection = sectionId;
      } else {
        const fallback = afterSection?.id ?? next?.sectionId;
        if (!fallback) throw badRequest("Pick a scene for the line.");
        targetSection = fallback;
      }

      await tx`update lines set seq = seq + 1 where production_id = ${p.id} and seq > ${afterSeq}`;
      const [row] = await tx<{ id: string }[]>`
        insert into lines (production_id, section_id, seq, kind, character_id, text, flagged, flag_code, flag_reason, source_line, source_page)
        values (${p.id}, ${targetSection}, ${afterSeq + 1}, ${kind}, ${characterId}, ${text}, ${flagged}, ${flagCode}, ${flagReason}, ${sourceLine}, ${sourcePage})
        returning id`;
      await tidySections(tx, p.id);
      return row!.id;
    });
    await afterCastChange(ctx, p.id);
    return { line: await selectLine(sql, newId) };
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
    await sql`update lines set flagged = false, flag_code = null, flag_reason = null where id = ${line.id}`;
    return { line: await selectLine(sql, line.id) };
  });

  app.post("/api/productions/:id/characters", async (req) => {
    const user = await requireDirector(ctx, req);
    const p = await ownedProduction(ctx, user, idOf(req.params));
    const name = requiredString(body(req.body), "name", 80);
    try {
      const [c] = await sql<{ id: string }[]>`insert into characters (production_id, name) values (${p.id}, ${name}) returning id`;
      await afterCastChange(ctx, p.id);
      return { character: characterView((await charactersOf(sql, p.id)).find((x) => x.id === c!.id)!) };
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict("name_taken", `There is already a character called ${name}.`);
      throw err;
    }
  });

  app.patch("/api/characters/:id", async (req) => {
    const user = await requireDirector(ctx, req);
    const c = await ownedCharacter(sql, user, idOf(req.params));
    const name = requiredString(body(req.body), "name", 80);
    const aliases =
      name.toLowerCase() === c.name.toLowerCase() ? c.aliases : [...new Set([...c.aliases, c.name])].filter((a) => a.toLowerCase() !== name.toLowerCase());
    try {
      await sql`update characters set name = ${name}, aliases = ${aliases} where id = ${c.id}`;
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict("name_taken", `There is already a character called ${name}. Merge them instead.`);
      throw err;
    }
    await afterCastChange(ctx, c.productionId);
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
      // Shared lines and takes that named the merged character now name the one kept.
      await tx`
        update lines set voice_ids = array(
          select v from (select v, min(o) as o from unnest(array_replace(voice_ids, ${from.id}::uuid, ${into.id}::uuid)) with ordinality as x(v, o) group by v) d order by o)
        where production_id = ${from.productionId} and ${from.id}::uuid = any(voice_ids)`;
      await tx`update takes set character_id = ${into.id} where character_id = ${from.id}`;
      await tx`update characters set aliases = ${aliases} where id = ${into.id}`;
      const [intoCast] = await tx`select 1 from actor_characters where character_id = ${into.id}`;
      if (intoCast) await tx`delete from actor_characters where character_id = ${from.id}`;
      else await tx`update actor_characters set character_id = ${into.id} where character_id = ${from.id}`;
      await tx`delete from characters where id = ${from.id}`;
    });
    await afterCastChange(ctx, from.productionId);
    return { characters: (await charactersOf(sql, from.productionId)).map(characterView) };
  });
}

// The group character for several speakers, by name ("ANGELO, ESCALUS"), made when it's new. Its
// members and its lines' voices come from sync_shared_lines.
async function groupCharacter(sql: Sql, productionId: string, name: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into characters (production_id, name, is_group) values (${productionId}, ${name}, true)
    on conflict (production_id, lower(name)) do update set name = characters.name returning id`;
  return row!.id;
}

// A speaker for a line being turned into dialogue: a character whose name or alias opens the text
// ("HAMLET. To be" → HAMLET, text "To be"), else whoever spoke the dialogue line before it.
async function guessSpeaker(sql: Sql, productionId: string, seq: number, text: string): Promise<{ characterId: string; text: string } | null> {
  const characters = await sql<{ id: string; name: string; aliases: string[] }[]>`
    select id, name, aliases from characters where production_id = ${productionId}`;
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const named = characters
    .flatMap((c) => [c.name, ...c.aliases].map((n) => ({ id: c.id, n: n.replace(/[.:]+$/, "") })))
    .filter((x) => x.n.length >= 2)
    .sort((a, b) => b.n.length - a.n.length);
  for (const { id, n } of named) {
    const m = new RegExp(`^\\s*${escape(n)}(?:\\s*[.:]\\s*|\\s+(?=[\\p{Lu}"“'(\\[]))`, "iu").exec(text);
    if (m && text.slice(m[0].length).trim()) return { characterId: id, text: text.slice(m[0].length).trim() };
  }
  const [previous] = await sql<{ characterId: string }[]>`
    select character_id from lines where production_id = ${productionId} and seq < ${seq} and kind = 'dialogue' and character_id is not null
    order by seq desc limit 1`;
  if (previous) return { characterId: previous.characterId, text };
  const [next] = await sql<{ characterId: string }[]>`
    select character_id from lines where production_id = ${productionId} and seq > ${seq} and kind = 'dialogue' and character_id is not null
    order by seq limit 1`;
  return next ? { characterId: next.characterId, text } : null;
}
