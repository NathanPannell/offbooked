import type { FastifyInstance } from "fastify";
import { ownedProduction, requireDirector } from "../auth.ts";
import type { Ctx } from "../context.ts";
import { HttpError, badRequest, conflict } from "../errors.ts";
import { body, idOf, optionalDate, requiredString, type Body } from "../input.ts";
import { MAX_SCRIPT_CHARS, pageIndex, prepareText } from "../parse/pipeline.ts";
import { startScriptParse, type ScriptSource } from "../parse/job.ts";
import { PAGE_BREAK, ScriptInputError } from "../parse/pdf.ts";
import { decodeText, detectSourceKind, type SourceKind } from "../parse/source.ts";
import { enforce, LIMITS } from "../ratelimit.ts";
import { ContentDeletedError, RETENTION_DAYS } from "../retention.ts";
import { contentTypeForKey } from "../storage/storage.ts";
import { charactersOf, characterView, linesOf, lineView, productionRows, productionView, sectionsOf, sectionView } from "../views.ts";

export const MAX_PDF_BYTES = 20 * 1024 * 1024;

const DAY_MS = 86_400_000;

interface PerformanceDates {
  startsOn: string | null;
  endsOn: string | null;
}

const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const deletionMoment = (endsOn: string) => Date.parse(`${endsOn}T12:00:00Z`) + RETENTION_DAYS * DAY_MS;

// Performance dates from a create (no `current`) or update body. Every production has a final
// date, because content is deleted RETENTION_DAYS after it: a new one without dates gets one year
// from today, and a start date alone is a single performance. A new final date may be at most
// RETENTION_DAYS - 1 days ago (UTC), so its deletion (12:00 UTC on contentDeletesOn) is always at
// least 12 hours off and a typo can't delete a show. Once content is due, the final date is fixed.
export function performanceDates(b: Body, current?: PerformanceDates, now = Date.now()): PerformanceDates {
  const start = optionalDate(b, "performanceStartsOn");
  const end = optionalDate(b, "performanceEndsOn");
  if (current && end === null) throw badRequest("A production needs a final performance date.");
  if (current?.endsOn && end && end !== current.endsOn && deletionMoment(current.endsOn) <= now)
    throw conflict("content_due", "This production's script and recordings are due for deletion, so its final performance can't be changed.");
  const startsOn = start === undefined ? (current?.startsOn ?? null) : start;
  let endsOn = end ?? current?.endsOn ?? null;
  if (!current && !endsOn) {
    const inAYear = new Date(now);
    inAYear.setUTCFullYear(inAYear.getUTCFullYear() + 1);
    endsOn = startsOn ?? inAYear.toISOString().slice(0, 10);
  }
  if (startsOn && endsOn && startsOn > endsOn) throw badRequest("The first performance must be on or before the final one.");
  if (endsOn && endsOn !== current?.endsOn && endsOn < isoDay(now - (RETENTION_DAYS - 1) * DAY_MS))
    throw badRequest(
      `That final performance was more than ${RETENTION_DAYS - 1} days ago. Offbooked deletes a show's script and recordings ${RETENTION_DAYS} days after its final performance.`,
    );
  return { startsOn, endsOn };
}

export function productionRoutes(app: FastifyInstance, ctx: Ctx) {
  app.get("/api/productions", async (req) => {
    const user = await requireDirector(ctx, req);
    return { productions: (await productionRows(ctx.sql, { ownerId: user.id })).map(productionView) };
  });

  app.post("/api/productions", async (req) => {
    const user = await requireDirector(ctx, req);
    const b = body(req.body);
    const title = requiredString(b, "title", 200);
    const dates = performanceDates(b);
    const [row] = await ctx.sql<{ id: string }[]>`
      insert into productions (owner_id, title, performance_starts_on, performance_ends_on)
      values (${user.id}, ${title}, ${dates.startsOn}, ${dates.endsOn}) returning id`;
    ctx.retention.kick();
    return { production: productionView(await ownedProduction(ctx, user, row!.id)) };
  });

  app.get("/api/productions/:id", async (req) => {
    const user = await requireDirector(ctx, req);
    return { production: productionView(await ownedProduction(ctx, user, idOf(req.params))) };
  });

  app.patch("/api/productions/:id", async (req) => {
    const user = await requireDirector(ctx, req);
    const p = await ownedProduction(ctx, user, idOf(req.params));
    const b = body(req.body);
    const title = b.title === undefined ? undefined : requiredString(b, "title", 200);
    const dates = performanceDates(b, { startsOn: p.performanceStartsOn, endsOn: p.performanceEndsOn });
    const endChanged = dates.endsOn !== p.performanceEndsOn;
    // A new final date only lands while the old one isn't due yet (checked again here, in the same
    // statement, so a pass starting at 12:00 UTC can't delete a show whose date just moved).
    const updated = await ctx.sql`update productions set
      title = ${title ?? p.title},
      performance_starts_on = ${dates.startsOn},
      performance_ends_on = ${dates.endsOn}
      where id = ${p.id}
        ${endChanged ? ctx.sql`and content_deleted_at is null and (performance_ends_on is null or (((performance_ends_on + ${RETENTION_DAYS}::int) + time '12:00') at time zone 'UTC') > now())` : ctx.sql``}
      returning id`;
    if (!updated.length)
      throw conflict("content_due", "This production's script and recordings are due for deletion, so its final performance can't be changed.");
    if (endChanged) ctx.retention.kick();
    return { production: productionView(await ownedProduction(ctx, user, p.id)) };
  });

  app.post("/api/productions/:id/archive", async (req, reply) => {
    const user = await requireDirector(ctx, req);
    const p = await ownedProduction(ctx, user, idOf(req.params));
    await ctx.sql`update productions set archived_at = coalesce(archived_at, now()) where id = ${p.id}`;
    return reply.code(204).send();
  });

  app.post("/api/productions/:id/script", { bodyLimit: 4 * 1024 * 1024 }, async (req, reply) => {
    const user = await requireDirector(ctx, req);
    const p = await ownedProduction(ctx, user, idOf(req.params));
    if (p.contentDeletedAt) throw new HttpError(410, "content_deleted", "This production's script and recordings were deleted after its final performance.");
    if (p.scriptStatus === "parsing") throw conflict("parse_in_progress", "This script is still being read. Wait for it to finish.");
    const [recorded] = await ctx.sql`select 1 from takes where production_id = ${p.id} limit 1`;
    if (recorded) throw conflict("has_recordings", "Actors have already recorded lines, so the script can't be replaced.");

    let source: ScriptSource;
    if (req.isMultipart()) {
      const file = await req.file({ limits: { fileSize: MAX_PDF_BYTES, files: 1 } });
      if (!file || file.fieldname !== "file") throw badRequest("Attach the script in a field named file.");
      const data = await file.toBuffer();
      let kind: SourceKind;
      try {
        kind = detectSourceKind(data, file.filename);
      } catch (err) {
        if (err instanceof ScriptInputError) throw new HttpError(415, "unsupported_media_type", err.message);
        throw err;
      }
      if (kind === "text") {
        const text = decodeText(data);
        if (text.length > MAX_SCRIPT_CHARS)
          throw new HttpError(413, "payload_too_large", "This script is too long. Split it into parts under 600,000 characters.");
        source = { kind: "text", text, data };
      } else {
        source = { kind, data };
      }
    } else {
      const text = body(req.body).text;
      if (typeof text !== "string" || !text.trim()) throw badRequest("Upload the script as a PDF or Word file.");
      if (text.length > MAX_SCRIPT_CHARS)
        throw new HttpError(413, "payload_too_large", "This script is too long. Split it into parts under 600,000 characters.");
      source = { kind: "text", text };
    }
    await enforce(ctx.sql, ctx.log, `parse:${user.id}`, LIMITS.scriptParse, "Too many script uploads in the last hour. Try again later.");
    await enforce(ctx.sql, ctx.log, `parse-ip:${req.ip}`, LIMITS.scriptParseIp, "Too many script uploads in the last hour. Try again later.");
    try {
      await startScriptParse(ctx, p.id, source);
    } catch (err) {
      if (err instanceof ContentDeletedError) throw new HttpError(410, "content_deleted", err.message);
      throw err;
    }
    return reply.code(202).send({ scriptStatus: "parsing" });
  });

  app.get("/api/productions/:id/script", async (req) => {
    const user = await requireDirector(ctx, req);
    const p = await ownedProduction(ctx, user, idOf(req.params));
    const [sections, characters, lines] = await Promise.all([sectionsOf(ctx.sql, p.id), charactersOf(ctx.sql, p.id), linesOf(ctx.sql, p.id)]);
    const [latest] =
      p.scriptStatus === "parsing"
        ? await ctx.sql<{ progress: unknown }[]>`select progress from scripts where production_id = ${p.id} order by created_at desc limit 1`
        : [];
    return {
      status: p.scriptStatus,
      error: p.scriptError,
      progress: latest?.progress ?? null,
      sections: sections.map(sectionView),
      characters: characters.map(characterView),
      lines: lines.map(lineView),
      flaggedCount: lines.filter((l) => l.flagged).length,
    };
  });

  // The original upload and the prepared text, for reviewing a line next to where it came from.
  const latestReadyScript = async (productionId: string) => {
    const [row] = await ctx.sql<{ sourceKind: SourceKind; storageKey: string; rawText: string | null }[]>`
      select source_kind, storage_key, raw_text from scripts where production_id = ${productionId} and status = 'ready'
      order by created_at desc limit 1`;
    if (!row) throw new HttpError(404, "not_found", "There's no script for this production yet.");
    return row;
  };

  app.get("/api/productions/:id/script/source", async (req) => {
    const user = await requireDirector(ctx, req);
    const p = await ownedProduction(ctx, user, idOf(req.params));
    const q = req.query as { line?: string; context?: string };
    const line = Number(q.line);
    if (!Number.isInteger(line) || line < 1) throw badRequest("line must be a positive whole number.");
    const context = Math.min(200, Math.max(5, Number(q.context) || 40));
    const script = await latestReadyScript(p.id);
    const docLines = prepareText(script.rawText ?? "").text.split("\n");
    const pageOf = pageIndex(docLines);
    const from = Math.max(1, line - context);
    const to = Math.min(docLines.length, line + context);
    const lines: { n: number; text: string; page: number | null }[] = [];
    for (let n = from; n <= to; n++) {
      const text = docLines[n - 1]!;
      if (text === PAGE_BREAK) continue;
      lines.push({ n, text, page: pageOf(n) });
    }
    const pageCount = pageOf(docLines.length);
    return { kind: script.sourceKind, pageCount, from, lines };
  });

  app.get("/api/productions/:id/script/file", async (req, reply) => {
    const user = await requireDirector(ctx, req);
    const p = await ownedProduction(ctx, user, idOf(req.params));
    const script = await latestReadyScript(p.id);
    const data = await ctx.storage.get(script.storageKey);
    reply.header("Content-Type", contentTypeForKey(script.storageKey));
    reply.header("Cache-Control", "private, max-age=300");
    return reply.send(data);
  });
}
