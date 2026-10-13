import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import { requireActor, type ActorSession } from "../auth.ts";
import type { Ctx } from "../context.ts";
import { isUuid } from "../crypto.ts";
import { notifyActorDone } from "../email/notify.ts";
import { HttpError, badRequest, conflict, notFound } from "../errors.ts";
import { body, idOf, idParam, requiredEmail, requiredString } from "../input.ts";
import { enforce, LIMITS } from "../ratelimit.ts";
import { probeDurationSeconds } from "../render/ffmpeg.ts";
import { scheduleRender } from "../render/queue.ts";
import { runThrough } from "../runthrough.ts";
import { castRows, linesOf, lineView, sectionsOf, sectionView, takeView, type LineRow, type TakeRow } from "../views.ts";

export const MAX_TAKE_BYTES = 8 * 1024 * 1024;
export const MAX_TAKES_PER_LINE = 25;
export const MAX_ACTOR_BYTES = 200 * 1024 * 1024;
const MAX_TAKE_MS = 120_000;
const AUDIO_TYPES: Record<string, string> = {
  "audio/webm": "webm",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/aac": "m4a",
  "audio/ogg": "ogg",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
};
const WORD_OPS = new Set(["ok", "sub", "del", "ins"]);

const takeColumns = (sql: Ctx["sql"]) => sql`id, line_id, storage_key, duration_ms, created_at, stt_transcript, stt_accuracy, stt_ops`;

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

  // Own lines only, each with the single previous line by someone else as its cue.
  app.get("/api/invite/lines", async (req) => {
    const s = await requireActor(ctx, req);
    const [lines, sections] = await Promise.all([linesOf(sql, s.production.id), sectionsOf(sql, s.production.id)]);
    const mine = new Set(s.characterIds);
    const takeIds = new Set<string>();
    const items: { line: LineRow; cue: LineRow | null; directions: string[] }[] = [];
    lines.forEach((line, i) => {
      if (line.kind !== "dialogue" || !mine.has(line.characterId!)) return;
      let cue: LineRow | null = null;
      for (let j = i - 1; j >= 0; j--) {
        const prev = lines[j]!;
        if (prev.kind === "dialogue" && !mine.has(prev.characterId!)) {
          cue = prev;
          break;
        }
      }
      const directions: string[] = [];
      for (let j = i - 1; j >= 0 && lines[j]!.kind !== "dialogue"; j--) if (lines[j]!.kind === "stage_direction") directions.unshift(lines[j]!.text);
      if (line.currentTakeId) takeIds.add(line.currentTakeId);
      if (cue?.currentTakeId) takeIds.add(cue.currentTakeId);
      items.push({ line, cue, directions });
    });
    const takes = takeIds.size ? await sql<TakeRow[]>`select ${takeColumns(sql)} from takes where id = any(${[...takeIds]}::uuid[])` : [];
    const byId = new Map(takes.map((t) => [t.id, t]));
    const characterNames = new Map(
      (await sql<{ id: string; name: string }[]>`select id, name from characters where production_id = ${s.production.id}`).map((c) => [c.id, c.name]),
    );
    const sectionTitles = new Map(sections.map((sec) => [sec.id, sec.title]));
    const usedSections = new Set(items.map((it) => it.line.sectionId));
    return {
      sections: sections.filter((sec) => usedSections.has(sec.id)).map(sectionView),
      lines: await Promise.all(
        items.map(async ({ line, cue, directions }) => {
          const cueTake = cue?.currentTakeId ? byId.get(cue.currentTakeId) : undefined;
          const take = line.currentTakeId ? byId.get(line.currentTakeId) : undefined;
          return {
            line: lineView(line),
            sectionTitle: sectionTitles.get(line.sectionId) ?? "",
            cue: cue ? { characterName: characterNames.get(cue.characterId!) ?? "", text: cue.text, audioUrl: cueTake ? await storage.signedUrl(cueTake.storageKey) : null } : null,
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
    const takeId = req.headers["x-take-id"];
    if (!isUuid(takeId)) throw badRequest("X-Take-Id must be a UUID.");
    const id = takeId.toLowerCase();

    const respond = async () => {
      const [take] = await sql<TakeRow[]>`select ${takeColumns(sql)} from takes where id = ${id}`;
      const c = await counts(ctx, s);
      return { take: await takeView(storage, take!), linesRecorded: c.linesRecorded, linesTotal: c.linesTotal };
    };

    const [existing] = await sql<{ actorId: string; lineId: string }[]>`select actor_id, line_id from takes where id = ${id}`;
    if (existing) {
      if (existing.actorId !== s.actor.id || existing.lineId !== lineId) throw conflict("take_id_conflict", "That take id was already used for another recording.");
      return respond();
    }

    const [line] = await sql<{ id: string }[]>`
      select id from lines where id = ${lineId} and production_id = ${s.production.id} and kind = 'dialogue'
        and character_id = any(${s.characterIds}::uuid[])`;
    if (!line) throw notFound("Line not found.");
    const contentType = String(req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
    const ext = AUDIO_TYPES[contentType];
    if (!ext) throw new HttpError(415, "unsupported_media_type", "Recordings must be webm, mp4, ogg or wav audio.");
    const audio = req.body;
    if (!Buffer.isBuffer(audio) || audio.length === 0) throw badRequest("The recording is empty.");

    await enforce(sql, ctx.log, `take:${s.actor.id}`, LIMITS.takeUpload, "You're recording very fast. Wait a minute and try again.");
    const [usage] = await sql<{ lineTakes: number; bytes: number }[]>`
      select (select count(*)::int from takes where actor_id = ${s.actor.id} and line_id = ${lineId}) as line_takes,
             (select coalesce(sum(bytes), 0)::float8 from takes where actor_id = ${s.actor.id}) as bytes`;
    if (usage!.lineTakes >= MAX_TAKES_PER_LINE) throw conflict("take_limit", `You've recorded this line ${MAX_TAKES_PER_LINE} times. Keep your best take or ask your director.`);
    if (usage!.bytes + audio.length > MAX_ACTOR_BYTES) throw new HttpError(413, "storage_limit", "You've reached the recording limit for this production. Ask your director.");

    const durationMs = await measure(audio, ext, Number(req.headers["x-duration-ms"]));
    if (durationMs === null) throw badRequest("We couldn't read that recording. Try recording it again.");
    if (durationMs > MAX_TAKE_MS) throw badRequest("Takes can be up to two minutes long.");

    const key = `productions/${s.production.id}/takes/${id}.${ext}`;
    await storage.put(key, audio, contentType);
    await sql.begin(async (tx) => {
      const [inserted] = await tx`
        insert into takes (id, production_id, line_id, actor_id, storage_key, content_type, bytes, duration_ms)
        values (${id}, ${s.production.id}, ${lineId}, ${s.actor.id}, ${key}, ${contentType}, ${audio.length}, ${durationMs})
        on conflict (id) do nothing returning id`;
      if (inserted) await tx`update lines set current_take_id = ${id}, updated_at = now() where id = ${lineId}`;
    });
    await sql`update actors set last_active_at = now(), opened_at = coalesce(opened_at, now()) where id = ${s.actor.id}`;

    const result = await respond();
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

// ffprobe the upload; the client's X-Duration-Ms is the fallback when probing fails.
async function measure(audio: Buffer, ext: string, clientMs: number): Promise<number | null> {
  const dir = await mkdtemp(path.join(tmpdir(), "offbooked-take-"));
  try {
    const file = path.join(dir, `take.${ext}`);
    await writeFile(file, audio);
    const seconds = await probeDurationSeconds(file);
    if (seconds) return Math.round(seconds * 1000);
    return Number.isFinite(clientMs) && clientMs > 0 ? Math.round(clientMs) : null;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
