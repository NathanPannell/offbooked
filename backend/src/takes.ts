import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyRequest } from "fastify";
import type { Ctx } from "./context.ts";
import { isUuid } from "./crypto.ts";
import { HttpError, badRequest, conflict, notFound } from "./errors.ts";
import { enforce, LIMITS } from "./ratelimit.ts";
import { probeDurationSeconds } from "./render/ffmpeg.ts";
import { scheduleRender } from "./render/queue.ts";
import { ContentDeletedError, sweepIfDeleted } from "./retention.ts";
import { parseWordStarts } from "./taketiming.ts";
import { takeColumns, takeView, type TakeRow } from "./views.ts";

// Take uploads, shared by the actor endpoint and the director's endpoint: same body,
// headers, idempotency, caps and response.

export const MAX_TAKE_BYTES = 8 * 1024 * 1024; // per request: a longer take comes in parts
export const MAX_TAKE_PARTS = 12; // so a take is at most 96 MB (well over an hour of phone audio)
export const MAX_TAKES_PER_LINE = 25; // per recorder
export const MAX_RECORDER_BYTES = 200 * 1024 * 1024; // per actor, or per director per production
// Only a safety net (the app stops a take left running for an hour): takes have no real length cap.
const MAX_TAKE_MS = 65 * 60_000;
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

export type Recorder = { kind: "actor"; actorId: string } | { kind: "director"; userId: string };

export interface TakeUpload {
  productionId: string;
  lineId: string;
  recorder: Recorder;
  lineAllowed: () => Promise<boolean>; // the recorder may record this line
  voiceId?: () => Promise<string | null>; // on a shared line, the character this take voices
  counts: () => Promise<{ linesRecorded: number; linesTotal: number }>;
  messages?: { lineCap?: string; storageCap?: string };
}

export async function acceptTake(ctx: Ctx, req: FastifyRequest, u: TakeUpload) {
  const { sql, storage } = ctx;
  const takeId = req.headers["x-take-id"];
  if (!isUuid(takeId)) throw badRequest("X-Take-Id must be a UUID.");
  const id = takeId.toLowerCase();
  const director = u.recorder.kind === "director";
  const actorId = u.recorder.kind === "actor" ? u.recorder.actorId : null;
  const userId = u.recorder.kind === "director" ? u.recorder.userId : null;

  const respond = async (created: boolean) => {
    const [take] = await sql<TakeRow[]>`select ${takeColumns(sql)} from takes where id = ${id}`;
    const c = await u.counts();
    return {
      body: { take: await takeView(storage, take!, actorId ? { actorId } : { userId: userId! }), linesRecorded: c.linesRecorded, linesTotal: c.linesTotal },
      created,
    };
  };

  // A repeated X-Take-Id returns the same take; the id can't be reused for another recording.
  const [existing] = await sql<{ actorId: string | null; recordedByUserId: string | null; recordedBy: string; lineId: string }[]>`
    select actor_id, recorded_by_user_id, recorded_by, line_id from takes where id = ${id}`;
  if (existing) {
    const same =
      existing.lineId === u.lineId && (director ? existing.recordedBy === "director" && existing.recordedByUserId === userId : existing.actorId === actorId);
    if (!same) throw conflict("take_id_conflict", "That take id was already used for another recording.");
    return respond(false);
  }

  if (!(await u.lineAllowed())) throw notFound("Line not found.");
  const contentType = String(req.headers["content-type"] ?? "")
    .split(";")[0]!
    .trim()
    .toLowerCase();
  const ext = AUDIO_TYPES[contentType];
  if (!ext) throw new HttpError(415, "unsupported_media_type", "Recordings must be webm, mp4, ogg or wav audio.");
  const body = req.body;
  if (!Buffer.isBuffer(body) || body.length === 0) throw badRequest("The recording is empty.");

  // A take bigger than one request arrives as byte ranges of the same file, in parts (X-Take-Parts,
  // X-Take-Part, 0-based). Parts wait in a temp folder until all are in, then join back into the
  // exact file the phone recorded. Until then the answer says which parts are still missing.
  let audio = body;
  const parts = req.headers["x-take-parts"] === undefined ? 1 : Number(req.headers["x-take-parts"]);
  if (parts !== 1) {
    const part = Number(req.headers["x-take-part"]);
    if (!Number.isInteger(parts) || parts < 2 || parts > MAX_TAKE_PARTS) throw badRequest(`X-Take-Parts must be 2 to ${MAX_TAKE_PARTS}.`);
    if (!Number.isInteger(part) || part < 0 || part >= parts) throw badRequest("X-Take-Part must be a part number below X-Take-Parts.");
    const joined = await stagePart(id, parts, part, body);
    if (!joined.audio) return { body: { partial: true as const, parts, missing: joined.missing }, created: false as const };
    audio = joined.audio;
  }

  const who = director ? `director:${userId}` : actorId!;
  await enforce(sql, ctx.log, `take:${who}`, LIMITS.takeUpload, "You're recording very fast. Wait a minute and try again.");
  const [usage] = director
    ? await sql<{ lineTakes: number; bytes: number }[]>`
        select (select count(*)::int from takes where recorded_by_user_id = ${userId} and recorded_by = 'director' and line_id = ${u.lineId}) as line_takes,
               (select coalesce(sum(bytes), 0)::float8 from takes
                where recorded_by_user_id = ${userId} and recorded_by = 'director' and production_id = ${u.productionId}) as bytes`
    : await sql<{ lineTakes: number; bytes: number }[]>`
        select (select count(*)::int from takes where actor_id = ${actorId} and line_id = ${u.lineId}) as line_takes,
               (select coalesce(sum(bytes), 0)::float8 from takes where actor_id = ${actorId}) as bytes`;
  if (usage!.lineTakes >= MAX_TAKES_PER_LINE)
    throw conflict("take_limit", u.messages?.lineCap ?? `You've recorded this line ${MAX_TAKES_PER_LINE} times. Keep your best take or ask your director.`);
  if (usage!.bytes + audio.length > MAX_RECORDER_BYTES)
    throw new HttpError(413, "storage_limit", u.messages?.storageCap ?? "You've reached the recording limit for this production. Ask your director.");

  const durationMs = await measure(audio, ext, Number(req.headers["x-duration-ms"]));
  if (durationMs === null) throw badRequest("We couldn't read that recording. Try recording it again.");
  if (durationMs > MAX_TAKE_MS) throw badRequest("That take is over an hour long. Record it in shorter pieces.");

  // The newest take is current, whoever recorded it. Older takes are kept until the production's content is deleted (retention.ts).
  const voiceId = u.voiceId ? await u.voiceId() : null;
  // When each word started, as the app heard them (ms of this recording); dropped when they don't fit the line.
  const [line] = await sql<{ text: string }[]>`select text from lines where id = ${u.lineId}`;
  const wordStarts = parseWordStarts(req.headers["x-word-starts"], line?.text ?? "", durationMs);
  const key = `productions/${u.productionId}/takes/${id}.${ext}`;
  await storage.put(key, audio, contentType);
  if (await sweepIfDeleted(ctx, u.productionId)) throw new HttpError(410, "content_deleted", new ContentDeletedError().message);
  await sql.begin(async (tx) => {
    const [inserted] = await tx`
      insert into takes (id, production_id, line_id, actor_id, recorded_by, recorded_by_user_id, storage_key, content_type, bytes, duration_ms, character_id, word_starts_ms)
      values (${id}, ${u.productionId}, ${u.lineId}, ${actorId}, ${u.recorder.kind}, ${userId}, ${key}, ${contentType}, ${audio.length}, ${durationMs}, ${voiceId}, ${wordStarts}::int[])
      on conflict (id) do nothing returning id`;
    if (inserted) await tx`update lines set current_take_id = ${id}, updated_at = now() where id = ${u.lineId}`;
  });
  return respond(true);
}

// Deletes a take (or puts it back): the line's current take becomes its newest remaining one, so
// the run-through falls back to the previous take, then TTS. Nothing is removed from storage.
export async function setTakeDeleted(ctx: Ctx, takeId: string, deleted: boolean): Promise<void> {
  const [take] = await ctx.sql.begin(async (tx) => {
    const rows = await tx<{ lineId: string; productionId: string }[]>`
      update takes set deleted_at = ${deleted ? new Date() : null} where id = ${takeId} returning line_id, production_id`;
    if (rows[0]) {
      await tx`
        update lines set current_take_id = (
          select id from takes where line_id = ${rows[0].lineId} and deleted_at is null order by created_at desc limit 1), updated_at = now()
        where id = ${rows[0].lineId}`;
    }
    return rows;
  });
  if (take) await scheduleRender(ctx, take.productionId);
}

const PARTS_DIR = path.join(tmpdir(), "offbooked-take-parts");

// Saves one part of a take; once every part is in, joins them (and clears the folder).
async function stagePart(takeId: string, parts: number, part: number, bytes: Buffer): Promise<{ audio: Buffer | null; missing: number[] }> {
  const dir = path.join(PARTS_DIR, takeId);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, `${part}.part`), bytes);
  const have = new Set((await readdir(dir)).map((f) => Number(f.replace(/\.part$/, ""))));
  const missing = Array.from({ length: parts }, (_, i) => i).filter((i) => !have.has(i));
  if (missing.length) return { audio: null, missing };
  const audio = Buffer.concat(await Promise.all(Array.from({ length: parts }, (_, i) => readFile(path.join(dir, `${i}.part`)))));
  await rm(dir, { recursive: true, force: true });
  return { audio, missing: [] };
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
