import type { FastifyInstance } from "fastify";
import { ownedProduction, requireDirector } from "../auth.ts";
import type { Ctx } from "../context.ts";
import { idOf } from "../input.ts";
import { scheduleRender } from "../render/queue.ts";
import { renderView } from "../render/view.ts";
import { runThrough } from "../runthrough.ts";

export function runthroughRoutes(app: FastifyInstance, ctx: Ctx) {
  app.get("/api/productions/:id/runthrough", async (req) => {
    const user = await requireDirector(ctx, req);
    const p = await ownedProduction(ctx, user, idOf(req.params));
    return runThrough(ctx, p, []);
  });

  app.post("/api/productions/:id/render", async (req, reply) => {
    const user = await requireDirector(ctx, req);
    const p = await ownedProduction(ctx, user, idOf(req.params));
    await scheduleRender(ctx, p.id, { force: true });
    ctx.renderWorker.kick();
    return reply.code(202).send({ render: await renderView(ctx, p.id) });
  });
}
