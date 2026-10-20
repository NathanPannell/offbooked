import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Ctx } from "../context.ts";
import { verifyUnsubscribe } from "../email/notify.ts";
import { confirmVerification, linkStatus, readVerifyLink, type LinkStatus } from "../email/verify.ts";
import { notFound } from "../errors.ts";
import { consume, LIMITS } from "../ratelimit.ts";

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

// A small plain page for the links in emails, opened in the browser. `extra` is trusted HTML.
const page = (title: string, heading: string, text: string, extra = "") =>
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 16px;color:#1f1a17"><h1>${esc(heading)}</h1>
<p>${esc(text)}</p>${extra}</body>`;

const BUTTON = "font:inherit;font-weight:600;background:#1f1a17;color:#fff8ef;border:0;border-radius:999px;padding:12px 22px;min-height:44px;cursor:pointer";

type VerifyFields = { a?: string; e?: string; t?: string; s?: string; resubscribe?: string };

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

  const expired = (reply: FastifyReply) =>
    reply.code(410).send(page("Link expired", "This link has expired", "Open your cast link, tap your initials at the top right and send a new one."));
  const confirmed = (reply: FastifyReply, status: LinkStatus) =>
    reply.send(
      page(
        "Email confirmed",
        "Email confirmed",
        status.unsubscribed
          ? `Your email is confirmed. You'd unsubscribed from Offbooked emails, so you won't hear when ${status.title} is ready. You can close this page.`
          : `We'll email you when ${status.title} is ready to listen through. You can close this page.`,
      ),
    );

  // Opening and confirming the verification link, limited per IP. A limited request gets the same
  // kind of page, not JSON.
  const verifyRoute =
    (handle: (req: FastifyRequest, reply: FastifyReply, link: { actorId: string; email: string }) => Promise<unknown>) =>
    async (req: FastifyRequest, reply: FastifyReply) => {
      reply.type("text/html; charset=utf-8");
      if (!(await consume(ctx.sql, `verify-open-ip:${req.ip}`, LIMITS.verifyOpen))) {
        ctx.log.warn({ ip: req.ip }, "rate limit exceeded");
        return reply.code(429).send(page("Too many tries", "Too many tries", "Wait a few minutes, then open the link again."));
      }
      const fields: VerifyFields =
        req.method === "POST" ? { ...(req.query as VerifyFields), ...((req.body as VerifyFields | undefined) ?? {}) } : (req.query as VerifyFields);
      const link = readVerifyLink(ctx, fields);
      return link ? handle(req, reply, link) : expired(reply);
    };

  // The link in the verification email. Opening it changes nothing (mail scanners follow links): it
  // shows one Confirm button, whose POST carries the same signed fields.
  app.get(
    "/api/email/verify",
    verifyRoute(async (req, reply, link) => {
      const status = await linkStatus(ctx, link);
      if (!status) return expired(reply);
      if (status.state === "confirmed") return confirmed(reply, status);
      const q = req.query as VerifyFields;
      const hidden = (["a", "e", "t", "s"] as const).map((k) => `<input type="hidden" name="${k}" value="${esc(q[k] ?? "")}">`).join("");
      const note = status.unsubscribed
        ? `<p>You'd unsubscribed from Offbooked emails; confirming turns updates back on.</p><input type="hidden" name="resubscribe" value="1">`
        : "";
      return reply.send(
        page(
          "Confirm your email",
          "Confirm your email",
          `Tap the button and we'll email you when ${status.title} is ready to listen through.`,
          `<form method="post" action="/api/email/verify">${hidden}${note}<p style="margin:28px 0"><button type="submit" style="${BUTTON}">Confirm my email</button></p></form>`,
        ),
      );
    }),
  );

  app.post(
    "/api/email/verify",
    verifyRoute(async (req, reply, link) => {
      const status = await confirmVerification(ctx, link, (req.body as VerifyFields | undefined)?.resubscribe === "1");
      return status ? confirmed(reply, status) : expired(reply);
    }),
  );
}
