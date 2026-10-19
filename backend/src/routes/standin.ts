import type { FastifyInstance } from "fastify";
import { ownedProduction, requireDirector } from "../auth.ts";
import type { Ctx } from "../context.ts";
import { notFound } from "../errors.ts";
import { idOf } from "../input.ts";
import { cueViews, previousCue, saysLine } from "../lineaudio.ts";
import { togetherViews } from "./actor.ts";
import type { AudioSource } from "../render/plan.ts";
import { scheduleRender } from "../render/queue.ts";
import { acceptTake, MAX_TAKE_BYTES, setTakeDeleted } from "../takes.ts";
import { linesOf, lineView, productionRows, sectionsOf, sectionView, takeColumns, takeView, type LineRow, type SectionRow, type TakeRow } from "../views.ts";

// Stand-ins: the director records any line for a scene partner. A stand-in take becomes the line's
// current take until someone records it again, fills the run-through, and never counts toward an
// actor's progress or the completion emails.
export function standinRoutes(app: FastifyInstance, ctx: Ctx) {
  const { sql, storage } = ctx;

  app.put("/api/lines/:id/take", { bodyLimit: MAX_TAKE_BYTES }, async (req) => {
    const user = await requireDirector(ctx, req);
    const lineId = idOf(req.params);
    const [line] = await sql<{ productionId: string }[]>`
      select l.production_id from lines l join productions p on p.id = l.production_id
      where l.id = ${lineId} and p.owner_id = ${user.id} and l.kind = 'dialogue'`;
    if (!line) throw notFound("Line not found.");
    const { body, created } = await acceptTake(ctx, req, {
      productionId: line.productionId,
      lineId,
      recorder: { kind: "standin", userId: user.id },
      lineAllowed: async () => true,
      // On a shared line, the voice to stand in for (?characterId=), else its first voice.
      voiceId: async () => {
        const wanted = (req.query as { characterId?: string }).characterId?.toLowerCase();
        const [row] = await sql<{ voiceIds: string[] | null }[]>`select voice_ids from lines where id = ${lineId}`;
        const voices = row?.voiceIds;
        if (!voices) return null;
        return wanted && voices.includes(wanted) ? wanted : voices[0]!;
      },
      // Same response as the actor upload, with the production's progress (cast actors' takes only).
      counts: async () => {
        const [p] = await productionRows(sql, { ownerId: user.id, id: line.productionId, includeArchived: true });
        return { linesRecorded: p!.linesRecorded, linesTotal: p!.linesTotal };
      },
      messages: {
        lineCap: "You've recorded this line 25 times. Keep your best take.",
        storageCap: "You've reached the stand-in recording limit for this production.",
      },
    });
    if (created) await scheduleRender(ctx, line.productionId);
    return body;
  });

  // The director deletes any take in their production, a stand-in or the cast's (Undo: restore).
  for (const [method, url, deleted] of [
    ["DELETE", "/api/takes/:id", true],
    ["POST", "/api/takes/:id/restore", false],
  ] as const) {
    app.route({
      method,
      url,
      handler: async (req, reply) => {
        const user = await requireDirector(ctx, req);
        const takeId = idOf(req.params);
        const [take] = await sql`select 1 from takes t join productions p on p.id = t.production_id where t.id = ${takeId} and p.owner_id = ${user.id}`;
        if (!take) throw notFound("Take not found.");
        await setTakeDeleted(ctx, takeId, deleted);
        return reply.code(204).send();
      },
    });
  }

  // One section's dialogue for recording a scene partner by partner: each line with its current
  // take, where its audio comes from, and its cue (the previous line by another character).
  app.get("/api/productions/:id/sections/:sectionId/lines", async (req) => {
    const user = await requireDirector(ctx, req);
    const p = await ownedProduction(ctx, user, idOf(req.params));
    const [section] = await sql<SectionRow[]>`
      select id, seq, act, scene, title from sections where id = ${idOf(req.params, "sectionId")} and production_id = ${p.id}`;
    if (!section) throw notFound("Section not found.");
    const lines = await linesOf(sql, p.id);
    const items = lines.flatMap((line, i) =>
      line.kind === "dialogue" && line.sectionId === section.id ? [{ line, cue: previousCue(lines, i, (prev) => prev.characterId === line.characterId) }] : [],
    );
    return { section: sectionView(section), lines: await standinItems(p.id, items, null) };
  });

  // A character's studio: every line they say (shared ones too) across the play, with the same
  // detail as a scene. On a shared line the take shown is theirs and `together` has the others.
  app.get("/api/productions/:id/characters/:characterId/lines", async (req) => {
    const user = await requireDirector(ctx, req);
    const p = await ownedProduction(ctx, user, idOf(req.params));
    const [character] = await sql<{ id: string; name: string }[]>`
      select id, name from characters where id = ${idOf(req.params, "characterId")} and production_id = ${p.id}`;
    if (!character) throw notFound("Character not found.");
    const [lines, sections] = await Promise.all([linesOf(sql, p.id), sectionsOf(sql, p.id)]);
    const own = new Set([character.id]);
    const items = lines.flatMap((line, i) =>
      line.kind === "dialogue" && saysLine(line, own) ? [{ line, cue: previousCue(lines, i, (prev) => saysLine(prev, own)) }] : [],
    );
    const used = new Set(items.map((it) => it.line.sectionId));
    return {
      character,
      sections: sections.filter((s) => used.has(s.id)).map(sectionView),
      lines: await standinItems(p.id, items, character),
    };
  });

  async function standinItems(productionId: string, items: { line: LineRow; cue: LineRow | null }[], voice: { id: string; name: string } | null) {
    // A character's own take on a shared line, else each line's current take.
    const voiceTakeIds = voice
      ? new Map(
          (
            await sql<{ lineId: string; takeId: string | null }[]>`
              select lv.line_id, voice_take(lv.line_id, lv.shared, lv.character_id, false) as take_id
              from line_voices lv where lv.character_id = ${voice.id} and lv.shared and lv.production_id = ${productionId}`
          ).map((r) => [r.lineId, r.takeId]),
        )
      : new Map<string, string | null>();
    const takeFor = (line: LineRow) => (voice && line.voiceIds ? (voiceTakeIds.get(line.id) ?? null) : line.currentTakeId);
    const takeIds = items.flatMap((it) => takeFor(it.line) ?? []);
    const takes = new Map(
      (takeIds.length ? await sql<TakeRow[]>`select ${takeColumns(sql)} from takes where id = any(${takeIds}::uuid[])` : []).map((t) => [t.id, t]),
    );
    const names = new Map(
      (await sql<{ id: string; name: string }[]>`select id, name from characters where production_id = ${productionId}`).map((c) => [c.id, c.name]),
    );
    const ttsReady = ctx.tts ? Boolean(await ctx.tts.engine()) : false;
    const cues = await cueViews(
      ctx,
      productionId,
      items.map((it) => it.cue),
    );
    const together = await togetherViews(
      ctx,
      productionId,
      items.map((it) => it.line),
      new Set(voice ? [voice.id] : []),
    );
    return Promise.all(
      items.map(async ({ line }, i) => {
        const id = takeFor(line);
        const take = id ? takes.get(id) : undefined;
        const audioSource: AudioSource = take ? take.recordedBy : ttsReady ? "tts" : "none";
        return {
          line: lineView(line),
          // A shared line is read as the character in view, or by all its voices in a scene.
          characterName:
            voice?.name ??
            (line.voiceIds
              ? line.voiceIds
                  .map((v) => names.get(v) ?? "")
                  .filter(Boolean)
                  .join(" & ")
              : (names.get(line.characterId!) ?? "")),
          take: take ? await takeView(storage, take) : null,
          audioSource,
          cue: cues[i] ?? null,
          together: voice ? (together.get(line.id) ?? []) : [],
          voiceId: voice && line.voiceIds ? voice.id : null,
        };
      }),
    );
  }
}
