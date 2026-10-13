import type { FastifyInstance } from "fastify";
import { ownedProduction, requireDirector } from "../auth.ts";
import type { Ctx } from "../context.ts";
import { HttpError, badRequest, conflict } from "../errors.ts";
import { body, idOf, optionalDate, requiredString } from "../input.ts";
import { MAX_SCRIPT_CHARS } from "../parse/pipeline.ts";
import { startScriptParse, type ScriptSource } from "../parse/job.ts";
import { enforce, LIMITS } from "../ratelimit.ts";
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
      if (!file || file.fieldname !== "file") throw badRequest("Attach the PDF in a field named file.");
      const data = await file.toBuffer();
      if (data.subarray(0, 5).toString("latin1") !== "%PDF-") throw new HttpError(415, "unsupported_media_type", "That file isn't a PDF. Upload a PDF or paste the text.");
      source = { kind: "pdf", data };
    } else {
      const text = body(req.body).text;
      if (typeof text !== "string" || !text.trim()) throw badRequest("Paste the script text, or upload a PDF.");
      if (text.length > MAX_SCRIPT_CHARS) throw new HttpError(413, "payload_too_large", "This script is too long. Split it into parts under 600,000 characters.");
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
    return {
      status: p.scriptStatus,
      error: p.scriptError,
      sections: sections.map(sectionView),
      characters: characters.map(characterView),
      lines: lines.map(lineView),
      flaggedCount: lines.filter((l) => l.flagged).length,
    };
  });
}
