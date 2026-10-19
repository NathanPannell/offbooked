import type { FastifyInstance } from "fastify";
import { ownedProduction, requireDirector } from "../auth.ts";
import type { Ctx } from "../context.ts";
import { HttpError, badRequest, conflict } from "../errors.ts";
import { body, idOf, optionalDate, requiredString } from "../input.ts";
import { MAX_SCRIPT_CHARS, pageIndex, prepareText } from "../parse/pipeline.ts";
import { startScriptParse, type ScriptSource } from "../parse/job.ts";
import { PAGE_BREAK, ScriptInputError } from "../parse/pdf.ts";
import { decodeText, detectSourceKind, type SourceKind } from "../parse/source.ts";
import { enforce, LIMITS } from "../ratelimit.ts";
import { contentTypeForKey } from "../storage/storage.ts";
import { charactersOf, characterView, linesOf, lineView, productionRows, productionView, sectionsOf, sectionView } from "../views.ts";

export const MAX_PDF_BYTES = 20 * 1024 * 1024;

export function productionRoutes(app: FastifyInstance, ctx: Ctx) {
  app.get("/api/productions", async (req) => {
    const user = await requireDirector(ctx, req);
    return { productions: (await productionRows(ctx.sql, { ownerId: user.id })).map(productionView) };
  });

  app.post("/api/productions", async (req) => {
    const user = await requireDirector(ctx, req);
    const b = body(req.body);
    const title = requiredString(b, "title", 200);
    const performanceDate = optionalDate(b, "performanceDate") ?? null;
    const [row] = await ctx.sql<{ id: string }[]>`
      insert into productions (owner_id, title, performance_date) values (${user.id}, ${title}, ${performanceDate}) returning id`;
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
    const performanceDate = optionalDate(b, "performanceDate");
    await ctx.sql`update productions set
      title = ${title ?? p.title},
      performance_date = ${performanceDate === undefined ? p.performanceDate : performanceDate}
      where id = ${p.id}`;
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
      if (typeof text !== "string" || !text.trim()) throw badRequest("Paste the script text, or upload a file.");
      if (text.length > MAX_SCRIPT_CHARS)
        throw new HttpError(413, "payload_too_large", "This script is too long. Split it into parts under 600,000 characters.");
      source = { kind: "text", text };
    }
    await enforce(ctx.sql, ctx.log, `parse:${user.id}`, LIMITS.scriptParse, "Too many script uploads in the last hour. Try again later.");
    await startScriptParse(ctx, p.id, source);
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
