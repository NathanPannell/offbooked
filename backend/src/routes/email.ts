import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Ctx } from "../context.ts";
import { verifyUnsubscribe } from "../email/notify.ts";
import { confirmVerification, readVerifyLink } from "../email/verify.ts";
import { notFound } from "../errors.ts";
import { enforce, LIMITS } from "../ratelimit.ts";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

// A small plain page for the links in emails, opened in the browser.
const page = (title: string, heading: string, text: string) =>
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 16px;color:#1f1a17"><h1>${esc(heading)}</h1>
<p>${esc(text)}</p></body>`;

export function emailRoutes(app: FastifyInstance, ctx: Ctx) {
  // The link in ready-to-listen-through emails. POST is the one-click List-Unsubscribe form.
  const unsubscribe = async (req: FastifyRequest, reply: FastifyReply) => {
    const q = req.query as { e?: string; s?: string };
    const email = q.e && q.s ? verifyUnsubscribe(ctx, q.e, q.s) : null;
    if (!email) throw notFound("This unsubscribe link isn't valid.");
    await ctx.sql`insert into email_unsubscribes (email) values (${email}) on conflict do nothing`;
    return reply
      .type("text/html; charset=utf-8")
      .send(page("Unsubscribed", "You're unsubscribed", "Offbooked won't email you when a play is ready to listen through again."));
  };
  app.get("/api/email/unsubscribe", unsubscribe);
  app.post("/api/email/unsubscribe", unsubscribe);

  // The link in the verification email a cast member asks for in their profile.
  app.get("/api/email/verify", async (req, reply) => {
    await enforce(ctx.sql, ctx.log, `verify-open-ip:${req.ip}`, LIMITS.verifyOpen);
    const link = readVerifyLink(ctx, req.query as Record<string, string | undefined>);
    const done = link ? await confirmVerification(ctx, link) : null;
    reply.type("text/html; charset=utf-8");
    if (!done) {
      return reply.code(410).send(page("Link expired", "This link has expired", "Open your cast link, tap your initials at the top right and send a new one."));
    }
    return reply.send(page("Email confirmed", "Email confirmed", `We'll email you when ${done.title} is ready to listen through. You can close this page.`));
  });
}
