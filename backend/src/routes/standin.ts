import type { FastifyInstance } from "fastify";
import { ownedProduction, requireDirector } from "../auth.ts";
import type { Ctx } from "../context.ts";
import { notFound } from "../errors.ts";
import { idOf } from "../input.ts";
import { cueViews, previousCue } from "../lineaudio.ts";
import type { AudioSource } from "../render/plan.ts";
import { scheduleRender } from "../render/queue.ts";
import { acceptTake, MAX_TAKE_BYTES, setTakeDeleted } from "../takes.ts";
import { linesOf, lineView, productionRows, sectionView, takeColumns, takeView, type SectionRow, type TakeRow } from "../views.ts";

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
    const takeIds = items.flatMap((it) => (it.line.currentTakeId ? [it.line.currentTakeId] : []));
    const takes = new Map(
      (takeIds.length ? await sql<TakeRow[]>`select ${takeColumns(sql)} from takes where id = any(${takeIds}::uuid[])` : []).map((t) => [t.id, t]),
    );
    const names = new Map(
      (await sql<{ id: string; name: string }[]>`select id, name from characters where production_id = ${p.id}`).map((c) => [c.id, c.name]),
    );
    const ttsReady = ctx.tts ? Boolean(await ctx.tts.engine()) : false;
    const cues = await cueViews(ctx, p.id, items.map((it) => it.cue));
    return {
      section: sectionView(section),
      lines: await Promise.all(
        items.map(async ({ line }, i) => {
          const take = line.currentTakeId ? takes.get(line.currentTakeId) : undefined;
          const audioSource: AudioSource = take ? take.recordedBy : ttsReady ? "tts" : "none";
          return {
            line: lineView(line),
            characterName: names.get(line.characterId!) ?? "",
            take: take ? await takeView(storage, take) : null,
            audioSource,
            cue: cues[i] ?? null,
          };
        }),
      ),
    };
  });
}
