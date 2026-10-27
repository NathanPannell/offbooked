import type { FastifyInstance, FastifyRequest } from "fastify";
import { auditLog, auditView, recordAdminView } from "../admin/access.ts";
import { adminCreators, creatorView } from "../admin/creators.ts";
import { adminProductions, adminProductionView } from "../admin/productions.ts";
import { adminRecorders, recorderView } from "../admin/recorders.ts";
import { personTrace } from "../admin/trace.ts";
import { requireAdmin, type Director } from "../auth.ts";
import type { Ctx } from "../context.ts";
import { notFound } from "../errors.ts";
import { idParam } from "../input.ts";

// The admin area's API, under /api/admin. Every route registered inside the plugin below passes
// requireAdmin first (an onRequest hook, so a route can't forget it): anyone not in ADMIN_EMAILS
// gets 404. Each panel in the web app's admin registry (web/src/routes/admin/sections.ts) has its
// routes here, one function per panel in ADMIN_PANELS. Everything answers a request; nothing polls.

type AdminOf = (req: FastifyRequest) => Director;
type PanelRoutes = (app: FastifyInstance, ctx: Ctx, adminOf: AdminOf) => void;

const productions: PanelRoutes = (app, ctx) => {
  app.get("/productions", async (req) => {
    const { q } = req.query as { q?: string };
    return { productions: (await adminProductions(ctx.sql, typeof q === "string" ? q.slice(0, 200) : undefined)).map(adminProductionView) };
  });
};

const creators: PanelRoutes = (app, ctx) => {
  app.get("/creators", async () => ({ creators: (await adminCreators(ctx.sql)).map(creatorView) }));
};

const recorders: PanelRoutes = (app, ctx) => {
  app.get("/recorders", async () => ({ recorders: (await adminRecorders(ctx.sql)).map(recorderView) }));
};

// A person's trace (people.ts keys). Looking someone up is recorded like opening a production.
const people: PanelRoutes = (app, ctx, adminOf) => {
  app.get("/people/:key", async (req) => {
    const { key } = req.params as { key: string };
    const trace = await personTrace(ctx.sql, key);
    if (!trace) throw notFound("Nobody with that key.");
    await recordAdminView(ctx.sql, adminOf(req).id, "view_person", { subject: trace.key });
    return { person: trace };
  });
};

const audit: PanelRoutes = (app, ctx) => {
  app.get("/audit", async (req) => {
    const { productionId } = req.query as { productionId?: string };
    return { entries: (await auditLog(ctx.sql, { productionId: productionId ? idParam(productionId) : undefined })).map(auditView) };
  });
};

export const ADMIN_PANELS: PanelRoutes[] = [productions, creators, recorders, people, audit];

/** "GET /api/admin/…" for every admin route, filled as they register (the gate test walks it). */
export const ADMIN_ROUTES = new Set<string>();

export function adminRoutes(app: FastifyInstance, ctx: Ctx) {
  app.register(
    async (admin) => {
      const admins = new WeakMap<FastifyRequest, Director>();
      admin.addHook("onRoute", (route) => {
        for (const method of [route.method].flat()) if (method !== "HEAD") ADMIN_ROUTES.add(`${method} ${route.url}`);
      });
      admin.addHook("onRequest", async (req) => {
        admins.set(req, await requireAdmin(ctx, req));
      });
      const adminOf: AdminOf = (req) => admins.get(req)!;
      for (const panel of ADMIN_PANELS) panel(admin, ctx, adminOf);
    },
    { prefix: "/api/admin" },
  );
}
