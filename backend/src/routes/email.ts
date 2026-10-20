import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Ctx } from "../context.ts";
import { verifyUnsubscribe } from "../email/notify.ts";
import { notFound } from "../errors.ts";

const PAGE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Unsubscribed</title>
<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 16px;color:#1f1a17"><h1>You're unsubscribed</h1>
<p>Offbooked won't email you when a play is ready to listen through again.</p></body>`;

// The link in ready-to-listen-through emails. POST is the one-click List-Unsubscribe form.
export function emailRoutes(app: FastifyInstance, ctx: Ctx) {
  const unsubscribe = async (req: FastifyRequest, reply: FastifyReply) => {
    const q = req.query as { e?: string; s?: string };
    const email = q.e && q.s ? verifyUnsubscribe(ctx, q.e, q.s) : null;
    if (!email) throw notFound("This unsubscribe link isn't valid.");
    await ctx.sql`insert into email_unsubscribes (email) values (${email}) on conflict do nothing`;
    return reply.type("text/html; charset=utf-8").send(PAGE);
  };
  app.get("/api/email/unsubscribe", unsubscribe);
  app.post("/api/email/unsubscribe", unsubscribe);
}
