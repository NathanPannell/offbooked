import type { FastifyInstance } from "fastify";
import { requireActor, type ActorSession } from "../auth.ts";
import type { Ctx } from "../context.ts";
import { notifyActorDone } from "../email/notify.ts";
import { badRequest, notFound } from "../errors.ts";
import { body, idOf, idParam, requiredEmail, requiredString } from "../input.ts";
import { cueViews, previousCue, warmCues } from "../lineaudio.ts";
import { scheduleRender } from "../render/queue.ts";
import { runThrough } from "../runthrough.ts";
import { acceptTake, MAX_TAKE_BYTES } from "../takes.ts";
import { castRows, linesOf, lineView, sectionsOf, sectionView, takeColumns, takeView, type LineRow, type TakeRow } from "../views.ts";

const WORD_OPS = new Set(["ok", "sub", "del", "ins"]);

async function counts(ctx: Ctx, s: ActorSession) {
  const [row] = await castRows(ctx.sql, { productionId: s.production.id, actorId: s.actor.id });
  return row!;
}

function sttInput(raw: unknown) {
  const b = body(raw);
  const transcript = typeof b.transcript === "string" ? b.transcript.slice(0, 5000) : null;
  const accuracy = b.accuracy;
  if (transcript === null) throw badRequest("transcript is required.");
  if (typeof accuracy !== "number" || !(accuracy >= 0 && accuracy <= 1)) throw badRequest("accuracy must be a number from 0 to 1.");
  const ops = b.ops ?? [];
  if (!Array.isArray(ops) || ops.length > 2000) throw badRequest("ops must be a list.");
  const clean = ops.map((o) => {
    const op = (o as Record<string, unknown>)?.op;
    if (typeof op !== "string" || !WORD_OPS.has(op)) throw badRequest("Each op needs op: ok, sub, del or ins.");
    const word = (k: string) => {
      const v = (o as Record<string, unknown>)[k];
      return typeof v === "string" ? v.slice(0, 100) : undefined;
    };
    return { op, expected: word("expected"), heard: word("heard") };
  });
  return { transcript, accuracy, ops: clean };
}

export function actorRoutes(app: FastifyInstance, ctx: Ctx) {
  const { sql, storage } = ctx;

  app.get("/api/invite", async (req) => {
    const s = await requireActor(ctx, req);
    const c = await counts(ctx, s);
    // Start synthesizing TTS cues now, so they are ready by the time the recording screen loads.
    ctx.jobs.run("warm actor cues", async () => {
      const items = actorItems(await linesOf(sql, s.production.id), s.characterIds);
      await warmCues(ctx, s.production.id, items.flatMap((it) => (it.cue ? [it.cue] : [])));
    });
    const characters = await sql<{ id: string; name: string }[]>`
      select id, name from characters where id = any(${s.characterIds}::uuid[]) order by lower(name)`;
    return {
      production: { id: s.production.id, title: s.production.title, directorName: s.production.directorName },
      actor: { id: s.actor.id, name: s.actor.name, firstName: s.actor.firstName },
      characters,
      linesTotal: c.linesTotal,
      linesRecorded: c.linesRecorded,
      hasEmail: Boolean(s.actor.email),
    };
  });

  app.post("/api/invite/start", async (req, reply) => {
    const s = await requireActor(ctx, req);
    const firstName = requiredString(body(req.body), "firstName", 60);
    await sql`update actors set first_name = ${firstName}, opened_at = coalesce(opened_at, now()) where id = ${s.actor.id}`;
    return reply.code(204).send();
  });

  // Own lines only, each with the single previous line by someone else as its cue. `take` is the
  // actor's own latest take: a director's stand-in fills the run-through but isn't the actor's take.
  app.get("/api/invite/lines", async (req) => {
    const s = await requireActor(ctx, req);
    const [lines, sections] = await Promise.all([linesOf(sql, s.production.id), sectionsOf(sql, s.production.id)]);
    const items = actorItems(lines, s.characterIds);
    const ids = items.map((it) => it.line.id);
    const own = ids.length
      ? await sql<TakeRow[]>`
          select distinct on (line_id) ${takeColumns(sql)} from takes
          where line_id = any(${ids}::uuid[]) and recorded_by = 'actor' order by line_id, created_at desc`
      : [];
    const takeByLine = new Map(own.map((t) => [t.lineId, t]));
    const cues = await cueViews(ctx, s.production.id, items.map((it) => it.cue));
    const sectionTitles = new Map(sections.map((sec) => [sec.id, sec.title]));
    const usedSections = new Set(items.map((it) => it.line.sectionId));
    return {
      sections: sections.filter((sec) => usedSections.has(sec.id)).map(sectionView),
      lines: await Promise.all(
        items.map(async ({ line, directions }, i) => {
          const take = takeByLine.get(line.id);
          return {
            line: lineView(line),
            sectionTitle: sectionTitles.get(line.sectionId) ?? "",
            cue: cues[i] ?? null,
            directions,
            take: take ? await takeView(storage, take) : null,
          };
        }),
      ),
    };
  });

  app.put("/api/invite/lines/:lineId/take", { bodyLimit: MAX_TAKE_BYTES }, async (req) => {
    const s = await requireActor(ctx, req);
    const lineId = idOf(req.params, "lineId");
    const { body: result, created } = await acceptTake(ctx, req, {
      productionId: s.production.id,
      lineId,
      recorder: { kind: "actor", actorId: s.actor.id },
      lineAllowed: async () =>
        (await sql`
          select 1 from lines where id = ${lineId} and production_id = ${s.production.id} and kind = 'dialogue'
            and character_id = any(${s.characterIds}::uuid[])`).length > 0,
      counts: () => counts(ctx, s),
    });
    if (!created) return result;
    await sql`update actors set last_active_at = now(), opened_at = coalesce(opened_at, now()) where id = ${s.actor.id}`;
    if (result.linesTotal > 0 && result.linesRecorded === result.linesTotal) {
      const actor = { id: s.actor.id, name: s.actor.name, firstName: s.actor.firstName, linesTotal: result.linesTotal };
      ctx.jobs.run("notify actor done", () => notifyActorDone(ctx, s.production.id, actor));
    }
    await scheduleRender(ctx, s.production.id);
    return result;
  });

  app.post("/api/invite/takes/:takeId/stt", async (req, reply) => {
    const s = await requireActor(ctx, req);
    const stt = sttInput(req.body);
    const [take] = await sql`
      update takes set stt_transcript = ${stt.transcript}, stt_accuracy = ${stt.accuracy}, stt_ops = ${sql.json(stt.ops as never)}
      where id = ${idOf(req.params, "takeId")} and actor_id = ${s.actor.id} returning id`;
    if (!take) throw notFound("Take not found.");
    return reply.code(204).send();
  });

  app.post("/api/invite/contact", async (req, reply) => {
    const s = await requireActor(ctx, req);
    const email = requiredEmail(body(req.body), "email");
    await sql`update actors set email = ${email} where id = ${s.actor.id}`;
    return reply.code(204).send();
  });

  app.get("/api/invite/runthrough", async (req) => {
    const s = await requireActor(ctx, req);
    return runThrough(ctx, s.production, s.characterIds);
  });

  app.post("/api/invite/practice", async (req) => {
    const s = await requireActor(ctx, req);
    const b = body(req.body);
    if (b.mode !== "my_part") throw badRequest('mode must be "my_part".');
    if (!Array.isArray(b.results) || b.results.length === 0 || b.results.length > 5000) throw badRequest("results must be a non-empty list.");
    const results = b.results.map((r) => ({ lineId: idParam((r as Record<string, unknown>)?.lineId), ...sttInput(r) }));
    const ids = [...new Set(results.map((r) => r.lineId))];
    const [owned] = await sql<{ n: number }[]>`
      select count(*)::int as n from lines where id = any(${ids}::uuid[]) and production_id = ${s.production.id}
        and kind = 'dialogue' and character_id = any(${s.characterIds}::uuid[])`;
    if (owned!.n !== ids.length) throw badRequest("Practice results can only cover your own lines.");
    const avg = results.reduce((n, r) => n + r.accuracy, 0) / results.length;
    const [practice] = await sql<{ id: string; avgAccuracy: number; createdAt: Date }[]>`
      insert into practice_runs (production_id, actor_id, mode, results, avg_accuracy)
      values (${s.production.id}, ${s.actor.id}, ${b.mode}, ${sql.json(results as never)}, ${avg})
      returning id, avg_accuracy, created_at`;
    return { practice: { id: practice!.id, avgAccuracy: practice!.avgAccuracy, createdAt: practice!.createdAt.toISOString() } };
  });
}

// The actor's dialogue lines, each with its cue (the previous line by someone else) and the stage
// directions just before it.
function actorItems(lines: LineRow[], characterIds: string[]) {
  const mine = new Set(characterIds);
  const items: { line: LineRow; cue: LineRow | null; directions: string[] }[] = [];
  lines.forEach((line, i) => {
    if (line.kind !== "dialogue" || !mine.has(line.characterId!)) return;
    const directions: string[] = [];
    for (let j = i - 1; j >= 0 && lines[j]!.kind !== "dialogue"; j--) if (lines[j]!.kind === "stage_direction") directions.unshift(lines[j]!.text);
    items.push({ line, cue: previousCue(lines, i, (c) => mine.has(c)), directions });
  });
  return items;
}
