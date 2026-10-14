import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FastifyRequest } from "fastify";
import type { Ctx } from "./context.ts";
import { isUuid } from "./crypto.ts";
import { HttpError, badRequest, conflict, notFound } from "./errors.ts";
import { enforce, LIMITS } from "./ratelimit.ts";
import { probeDurationSeconds } from "./render/ffmpeg.ts";
import { takeColumns, takeView, type TakeRow } from "./views.ts";

// Take uploads, shared by the actor endpoint and the director's stand-in endpoint: same body,
// headers, idempotency, caps and response.

export const MAX_TAKE_BYTES = 8 * 1024 * 1024;
export const MAX_TAKES_PER_LINE = 25; // per recorder
export const MAX_RECORDER_BYTES = 200 * 1024 * 1024; // per actor, or per director per production for stand-ins
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

export type Recorder = { kind: "actor"; actorId: string } | { kind: "standin"; userId: string };

export interface TakeUpload {
  productionId: string;
  lineId: string;
  recorder: Recorder;
  lineAllowed: () => Promise<boolean>; // the recorder may record this line
  counts: () => Promise<{ linesRecorded: number; linesTotal: number }>;
  messages?: { lineCap?: string; storageCap?: string };
}

export async function acceptTake(ctx: Ctx, req: FastifyRequest, u: TakeUpload) {
  const { sql, storage } = ctx;
  const takeId = req.headers["x-take-id"];
  if (!isUuid(takeId)) throw badRequest("X-Take-Id must be a UUID.");
  const id = takeId.toLowerCase();
  const standin = u.recorder.kind === "standin";
  const actorId = u.recorder.kind === "actor" ? u.recorder.actorId : null;
  const userId = u.recorder.kind === "standin" ? u.recorder.userId : null;

  const respond = async (created: boolean) => {
    const [take] = await sql<TakeRow[]>`select ${takeColumns(sql)} from takes where id = ${id}`;
    const c = await u.counts();
    return { body: { take: await takeView(storage, take!), linesRecorded: c.linesRecorded, linesTotal: c.linesTotal }, created };
  };

  // A repeated X-Take-Id returns the same take; the id can't be reused for another recording.
  const [existing] = await sql<{ actorId: string | null; recordedByUserId: string | null; recordedBy: string; lineId: string }[]>`
    select actor_id, recorded_by_user_id, recorded_by, line_id from takes where id = ${id}`;
  if (existing) {
    const same = existing.lineId === u.lineId && (standin ? existing.recordedBy === "standin" && existing.recordedByUserId === userId : existing.actorId === actorId);
    if (!same) throw conflict("take_id_conflict", "That take id was already used for another recording.");
    return respond(false);
  }

  if (!(await u.lineAllowed())) throw notFound("Line not found.");
  const contentType = String(req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
  const ext = AUDIO_TYPES[contentType];
  if (!ext) throw new HttpError(415, "unsupported_media_type", "Recordings must be webm, mp4, ogg or wav audio.");
  const audio = req.body;
  if (!Buffer.isBuffer(audio) || audio.length === 0) throw badRequest("The recording is empty.");

  const who = standin ? `standin:${userId}` : actorId!;
  await enforce(sql, ctx.log, `take:${who}`, LIMITS.takeUpload, "You're recording very fast. Wait a minute and try again.");
  const [usage] = standin
    ? await sql<{ lineTakes: number; bytes: number }[]>`
        select (select count(*)::int from takes where recorded_by_user_id = ${userId} and recorded_by = 'standin' and line_id = ${u.lineId}) as line_takes,
               (select coalesce(sum(bytes), 0)::float8 from takes
                where recorded_by_user_id = ${userId} and recorded_by = 'standin' and production_id = ${u.productionId}) as bytes`
    : await sql<{ lineTakes: number; bytes: number }[]>`
        select (select count(*)::int from takes where actor_id = ${actorId} and line_id = ${u.lineId}) as line_takes,
               (select coalesce(sum(bytes), 0)::float8 from takes where actor_id = ${actorId}) as bytes`;
  if (usage!.lineTakes >= MAX_TAKES_PER_LINE)
    throw conflict("take_limit", u.messages?.lineCap ?? `You've recorded this line ${MAX_TAKES_PER_LINE} times. Keep your best take or ask your director.`);
  if (usage!.bytes + audio.length > MAX_RECORDER_BYTES)
    throw new HttpError(413, "storage_limit", u.messages?.storageCap ?? "You've reached the recording limit for this production. Ask your director.");

  const durationMs = await measure(audio, ext, Number(req.headers["x-duration-ms"]));
  if (durationMs === null) throw badRequest("We couldn't read that recording. Try recording it again.");
  if (durationMs > MAX_TAKE_MS) throw badRequest("Takes can be up to two minutes long.");

  // The newest take is current, whoever recorded it. Older takes are kept forever.
  const key = `productions/${u.productionId}/takes/${id}.${ext}`;
  await storage.put(key, audio, contentType);
  await sql.begin(async (tx) => {
    const [inserted] = await tx`
      insert into takes (id, production_id, line_id, actor_id, recorded_by, recorded_by_user_id, storage_key, content_type, bytes, duration_ms)
      values (${id}, ${u.productionId}, ${u.lineId}, ${actorId}, ${u.recorder.kind}, ${userId}, ${key}, ${contentType}, ${audio.length}, ${durationMs})
      on conflict (id) do nothing returning id`;
    if (inserted) await tx`update lines set current_take_id = ${id}, updated_at = now() where id = ${u.lineId}`;
  });
  return respond(true);
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
