import type { FastifyInstance } from "fastify";
import { requireActor, type ActorSession } from "../auth.ts";
import type { Ctx } from "../context.ts";
import { notifyActorsDone } from "../email/notify.ts";
import { badRequest, notFound } from "../errors.ts";
import { requestVerification } from "../email/verify.ts";
import { body, idOf, idParam, optionalEmail, requiredString, uuidList } from "../input.ts";
import { cueViews, previousCue, saysLine, warmCues } from "../lineaudio.ts";
import { scheduleRender } from "../render/queue.ts";
import { lineAudio, oneLineAudio, playPriority, warmIds } from "../linestream.ts";
import { takeRecorder, type RecordedBy } from "../recorders.ts";
import { runThrough } from "../runthrough.ts";
import { partCards } from "./join.ts";
import { TTS_PRIORITY } from "../tts/service.ts";
import { acceptTake, MAX_TAKE_BYTES, setTakeDeleted } from "../takes.ts";
import { castRows, linesOf, lineView, sectionsOf, sectionView, takeColumns, takePlayKey, takeView, voicesOf, type LineRow, type TakeRow } from "../views.ts";

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
      await warmCues(
        ctx,
        s.production.id,
        items.flatMap((it) => (it.cue ? [it.cue] : [])),
      );
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
      pendingEmail: Boolean(s.actor.pendingEmail),
    };
  });

  // An actor fixes their name (a typo when joining). It shows on the call sheet.
  app.patch("/api/invite/me", async (req) => {
    const s = await requireActor(ctx, req);
    const name = requiredString(body(req.body), "name", 60);
    await sql`update actors set name = ${name}, first_name = ${name.split(/\s+/)[0]!} where id = ${s.actor.id}`;
    return { actor: { id: s.actor.id, name, firstName: name.split(/\s+/)[0]! } };
  });

  // Parts the actor can pick up: every part they haven't picked, whoever else has, with how many of
  // its lines still play in the computer voice because nobody has recorded them, most needed first.
  app.get("/api/invite/parts", async (req) => {
    const s = await requireActor(ctx, req);
    const mine = new Set(s.characterIds);
    const parts = (await partCards(sql, s.production.id)).filter((c) => !mine.has(c.id));
    return { parts: parts.sort((a, b) => b.linesNeeded - a.linesNeeded || a.name.localeCompare(b.name)) };
  });

  // Picks up more parts after the first ones. Parts aren't owned, so this never conflicts.
  app.post("/api/invite/parts", async (req) => {
    const s = await requireActor(ctx, req);
    const characterIds = uuidList(body(req.body), "characterIds", true)!;
    if (!characterIds.length) throw badRequest("Pick at least one part.");
    const rows = await sql`
      select c.id from characters c where c.production_id = ${s.production.id} and not c.is_group and c.id = any(${characterIds}::uuid[])`;
    if (rows.length !== characterIds.length) throw badRequest("Some of those parts aren't in this production.");
    await sql`insert into actor_characters ${sql(characterIds.map((characterId) => ({ actorId: s.actor.id, characterId })))} on conflict do nothing`;
    const characters = await sql<{ id: string; name: string }[]>`
      select c.id, c.name from actor_characters ac join characters c on c.id = ac.character_id
      where ac.actor_id = ${s.actor.id} order by lower(c.name)`;
    return { characters };
  });

  app.post("/api/invite/start", async (req, reply) => {
    const s = await requireActor(ctx, req);
    const firstName = requiredString(body(req.body), "firstName", 60);
    await sql`update actors set first_name = ${firstName}, opened_at = coalesce(opened_at, now()) where id = ${s.actor.id}`;
    return reply.code(204).send();
  });

  // Own lines only, each with the single previous line by someone else as its cue. `take` is the
  // actor's own latest take. `current` is what plays now when that's someone else's take (another
  // cast member's or the director's): the line counts as recorded, and the actor can record over it.
  // A shared line lists the other people who say it in `together`, with their current takes, so
  // the actor can hear them while recording.
  app.get("/api/invite/lines", async (req) => {
    const s = await requireActor(ctx, req);
    const viewer = { actorId: s.actor.id };
    const [lines, sections] = await Promise.all([linesOf(sql, s.production.id), sectionsOf(sql, s.production.id)]);
    const items = actorItems(lines, s.characterIds);
    const ids = items.map((it) => it.line.id);
    const own = ids.length
      ? await sql<TakeRow[]>`
          select distinct on (line_id) ${takeColumns(sql)} from takes
          where line_id = any(${ids}::uuid[]) and recorded_by = 'actor' and deleted_at is null and actor_id = ${s.actor.id}
          order by line_id, created_at desc`
      : [];
    const current = await currentTakes(ctx, ids, s.characterIds, s.actor.id);
    const together = await togetherViews(
      ctx,
      s.production.id,
      items.map((it) => it.line),
      new Set(s.characterIds),
    );
    const takeByLine = new Map(own.map((t) => [t.lineId, t]));
    const cues = await cueViews(
      ctx,
      s.production.id,
      items.map((it) => it.cue),
    );
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
            take: take ? await takeView(storage, take, viewer) : null,
            current: take ? null : (current.get(line.id) ?? null),
            together: together.get(line.id) ?? [],
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
        (
          await sql`
          select 1 from lines where id = ${lineId} and production_id = ${s.production.id} and kind = 'dialogue'
            and (character_id = any(${s.characterIds}::uuid[]) or voice_ids && ${s.characterIds}::uuid[])`
        ).length > 0,
      // On a shared line the take is for the first of the actor's characters who says it.
      voiceId: async () => {
        const [row] = await sql<{ voiceIds: string[] | null }[]>`select voice_ids from lines where id = ${lineId}`;
        return row?.voiceIds?.find((id) => s.characterIds.includes(id)) ?? null;
      },
      counts: () => counts(ctx, s),
    });
    if (!created) return result;
    await sql`update actors set last_active_at = now(), opened_at = coalesce(opened_at, now()) where id = ${s.actor.id}`;
    ctx.jobs.run("notify actors done", () => notifyActorsDone(ctx, s.production.id));
    await scheduleRender(ctx, s.production.id);
    return result;
  });

  // Deletes one of the actor's own takes (Undo puts it back with `restore`). Answers with progress.
  for (const [method, url, deleted] of [
    ["DELETE", "/api/invite/takes/:takeId", true],
    ["POST", "/api/invite/takes/:takeId/restore", false],
  ] as const) {
    app.route({
      method,
      url,
      handler: async (req) => {
        const s = await requireActor(ctx, req);
        const takeId = idOf(req.params, "takeId");
        const [own] = await sql`select 1 from takes where id = ${takeId} and actor_id = ${s.actor.id} and production_id = ${s.production.id}`;
        if (!own) throw notFound("Take not found.");
        await setTakeDeleted(ctx, takeId, deleted);
        const c = await counts(ctx, s);
        return { linesRecorded: c.linesRecorded, linesTotal: c.linesTotal };
      },
    });
  }

  app.post("/api/invite/takes/:takeId/stt", async (req, reply) => {
    const s = await requireActor(ctx, req);
    const stt = sttInput(req.body);
    const [take] = await sql`
      update takes set stt_transcript = ${stt.transcript}, stt_accuracy = ${stt.accuracy}, stt_ops = ${sql.json(stt.ops as never)}
      where id = ${idOf(req.params, "takeId")} and actor_id = ${s.actor.id} returning id`;
    if (!take) throw notFound("Take not found.");
    return reply.code(204).send();
  });

  // Sends a verification link to the address (or again to the one waiting, without `email`). Only a
  // verified address gets the completion emails or keeps the cast member's details after the show.
  app.post("/api/invite/contact", async (req) => {
    const s = await requireActor(ctx, req);
    return requestVerification(ctx, s, optionalEmail(body(req.body), "email"), req.ip);
  });

  app.get("/api/invite/runthrough", async (req) => {
    const s = await requireActor(ctx, req);
    return runThrough(ctx, s.production, s.characterIds);
  });

  // Line-by-line playback for the run-through: any dialogue line in the actor's production, like
  // /api/invite/runthrough.
  app.get("/api/invite/lines/:lineId/audio", async (req) => {
    const s = await requireActor(ctx, req);
    return oneLineAudio(ctx, s.production.id, idOf(req.params, "lineId"), playPriority((req.query as { prefetch?: string }).prefetch));
  });

  app.post("/api/invite/lines/audio/warm", async (req) => {
    const s = await requireActor(ctx, req);
    return { lines: await lineAudio(ctx, s.production.id, warmIds(req.body), { priority: TTS_PRIORITY.prefetch }) };
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
        and kind = 'dialogue' and (character_id = any(${s.characterIds}::uuid[]) or voice_ids && ${s.characterIds}::uuid[])`;
    if (owned!.n !== ids.length) throw badRequest("Practice results can only cover your own lines.");
    const avg = results.reduce((n, r) => n + r.accuracy, 0) / results.length;
    const [practice] = await sql<{ id: string; avgAccuracy: number; createdAt: Date }[]>`
      insert into practice_runs (production_id, actor_id, mode, results, avg_accuracy)
      values (${s.production.id}, ${s.actor.id}, ${b.mode}, ${sql.json(results as never)}, ${avg})
      returning id, avg_accuracy, created_at`;
    return { practice: { id: practice!.id, avgAccuracy: practice!.avgAccuracy, createdAt: practice!.createdAt.toISOString() } };
  });
}

// The actor's dialogue lines (shared ones included), each with its cue (the previous line by
// someone else) and the stage directions just before it.
function actorItems(lines: LineRow[], characterIds: string[]) {
  const mine = new Set(characterIds);
  const items: { line: LineRow; cue: LineRow | null; directions: string[] }[] = [];
  lines.forEach((line, i) => {
    if (line.kind !== "dialogue" || !saysLine(line, mine)) return;
    const directions: string[] = [];
    for (let j = i - 1; j >= 0 && lines[j]!.kind !== "dialogue"; j--) if (lines[j]!.kind === "stage_direction") directions.unshift(lines[j]!.text);
    items.push({ line, cue: previousCue(lines, i, (prev) => saysLine(prev, mine)), directions });
  });
  return items;
}

export interface CurrentTakeView {
  source: "actor" | "director";
  by: string; // the recorder's first name (same as recordedBy.name)
  recordedBy: RecordedBy;
  mine: false;
  audioUrl: string;
}

interface CurrentTakeRow {
  lineId: string;
  actorId: string | null;
  recordedBy: "actor" | "director";
  storageKey: string;
  streamKey: string | null;
  actorName: string | null;
  userName: string | null;
  userEmail: string | null;
}

// What plays now on each of the actor's lines (the voice's current take) when it's someone else's.
async function currentTakes(ctx: Ctx, lineIds: string[], characterIds: string[], actorId: string): Promise<Map<string, CurrentTakeView>> {
  const out = new Map<string, CurrentTakeView>();
  if (!lineIds.length) return out;
  const rows = await ctx.sql<CurrentTakeRow[]>`
    select lv.line_id, t.actor_id, t.recorded_by, t.storage_key, t.stream_key, coalesce(a.first_name, split_part(a.name, ' ', 1)) as actor_name,
      u.name as user_name, u.email as user_email
    from line_voices lv join takes t on t.id = voice_take(lv.line_id, lv.shared, lv.character_id)
      left join actors a on a.id = t.actor_id
      left join users u on u.id = t.recorded_by_user_id
    where lv.line_id = any(${lineIds}::uuid[]) and lv.character_id = any(${characterIds}::uuid[])
    order by lv.line_id, t.created_at desc`;
  for (const r of rows) {
    if (out.has(r.lineId) || r.actorId === actorId) continue;
    const recordedBy = takeRecorder(r);
    out.set(r.lineId, { source: r.recordedBy, by: recordedBy.name, recordedBy, mine: false, audioUrl: await ctx.storage.signedUrl(takePlayKey(r)) });
  }
  return out;
}

export interface TogetherView {
  characterId: string;
  characterName: string;
  audioUrl: string | null; // their current take (a cast member's or the director's), null until someone records it
  audioSource: "actor" | "director" | "none";
}

// For each shared line, the other voices (not `mine`) and their current takes.
export async function togetherViews(ctx: Ctx, productionId: string, lines: LineRow[], mine: ReadonlySet<string>): Promise<Map<string, TogetherView[]>> {
  const out = new Map<string, TogetherView[]>();
  const shared = lines.filter((l) => l.voiceIds);
  if (!shared.length) return out;
  const rows = await ctx.sql<
    { lineId: string; characterId: string; name: string; storageKey: string | null; streamKey: string | null; recordedBy: "actor" | "director" | null }[]
  >`
    select lv.line_id, lv.character_id, c.name, t.storage_key, t.stream_key, t.recorded_by
    from line_voices lv join characters c on c.id = lv.character_id
      left join takes t on t.id = voice_take(lv.line_id, lv.shared, lv.character_id)
    where lv.production_id = ${productionId} and lv.line_id = any(${shared.map((l) => l.id)}::uuid[])
    order by lv.line_id, lv.ord`;
  for (const line of shared) {
    const views: TogetherView[] = [];
    for (const id of voicesOf(line)) {
      if (mine.has(id)) continue;
      const r = rows.find((x) => x.lineId === line.id && x.characterId === id);
      if (!r) continue;
      views.push({
        characterId: id,
        characterName: r.name,
        audioUrl: r.storageKey ? await ctx.storage.signedUrl(takePlayKey({ storageKey: r.storageKey, streamKey: r.streamKey })) : null,
        audioSource: r.recordedBy ?? "none",
      });
    }
    out.set(line.id, views);
  }
  return out;
}
