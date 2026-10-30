import type { FastifyInstance } from "fastify";
import { ownedProduction, requireDirector, viewableProduction } from "../auth.ts";
import type { Ctx } from "../context.ts";
import { idOf } from "../input.ts";
import { scheduleRender } from "../render/queue.ts";
import { renderView } from "../render/view.ts";
import { runThrough } from "../runthrough.ts";
import { lineAudio, oneLineAudio, playPriority, warmIds } from "../linestream.ts";
import { prebuildTracks } from "../track/prebuild.ts";
import { listenTrack } from "../track/track.ts";
import { TTS_PRIORITY } from "../tts/service.ts";

export function runthroughRoutes(app: FastifyInstance, ctx: Ctx) {
  app.get("/api/productions/:id/runthrough", async (req) => {
    const user = await requireDirector(ctx, req);
    const p = await viewableProduction(ctx, user, idOf(req.params));
    // About to listen: the usual tracks are built now if anything is missing (track/prebuild.ts).
    prebuildTracks(ctx, p.id, "open");
    return runThrough(ctx, p, []);
  });

  // Line-by-line playback (see linestream.ts). GET waits for the clip; ?prefetch=1 asks at a lower
  // priority than the line someone is waiting for.
  app.get("/api/productions/:id/lines/:lineId/audio", async (req) => {
    const user = await requireDirector(ctx, req);
    const p = await viewableProduction(ctx, user, idOf(req.params));
    return oneLineAudio(ctx, p.id, idOf(req.params, "lineId"), playPriority((req.query as { prefetch?: string }).prefetch));
  });

  app.post("/api/productions/:id/lines/audio/warm", async (req) => {
    const user = await requireDirector(ctx, req);
    const p = await viewableProduction(ctx, user, idOf(req.params));
    return { lines: await lineAudio(ctx, p.id, warmIds(req.body), { priority: TTS_PRIORITY.prefetch }) };
  });

  // One file for a stretch of the listen-through (track/track.ts), so it plays on with the phone
  // locked. A playback cache like the line audio, so an admin viewing the production can use it too.
  app.post("/api/productions/:id/listen-track", async (req) => {
    const user = await requireDirector(ctx, req);
    const p = await viewableProduction(ctx, user, idOf(req.params));
    return listenTrack(ctx, p.id, req.body);
  });

  app.post("/api/productions/:id/render", async (req, reply) => {
    const user = await requireDirector(ctx, req);
    const p = await ownedProduction(ctx, user, idOf(req.params));
    await scheduleRender(ctx, p.id, { force: true });
    return reply.code(202).send({ render: await renderView(ctx, p.id) });
  });
}
