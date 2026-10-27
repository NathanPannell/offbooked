import type { FastifyInstance } from "fastify";
import { requireDirector, SESSION_DAYS, type Director } from "../auth.ts";
import type { Ctx } from "../context.ts";
import { randomToken, sha256 } from "../crypto.ts";
import { HttpError, unauthorized } from "../errors.ts";
import { signInEmail } from "../email/templates.ts";
import { body, optionalString, requiredEmail, requiredString } from "../input.ts";
import { safeNext } from "../names.ts";
import { enforce, LIMITS } from "../ratelimit.ts";
import { deleteAccount } from "../retention.ts";

const LOGIN_TOKEN_MINUTES = 15;

export function authRoutes(app: FastifyInstance, ctx: Ctx) {
  app.post("/api/auth/request", async (req, reply) => {
    const input = body(req.body);
    const email = requiredEmail(input, "email");
    // Where the link lands after signing in. Anything outside /app is dropped, never an error.
    const next = safeNext(input.next);
    // Asked for from the iOS app: the link carries app=1, which is what makes it a universal link
    // that opens the app (web/public/.well-known/apple-app-site-association). Without it, a sign-in
    // started in Safari finishes in Safari even on a phone with the app installed.
    const inApp = input.app === true;
    await enforce(ctx.sql, ctx.log, `signin-ip:${req.ip}`, LIMITS.signInIp);
    await enforce(ctx.sql, ctx.log, `signin-email:${email}`, LIMITS.signInEmail, "Too many sign-in links for this email. Wait a few minutes and try again.");
    const token = randomToken();
    await ctx.sql`insert into login_tokens (token_hash, email, expires_at)
                  values (${sha256(token)}, ${email}, now() + ${LOGIN_TOKEN_MINUTES} * interval '1 minute')`;
    const link = `${ctx.config.appUrl}/auth/verify?token=${token}${next ? `&next=${encodeURIComponent(next)}` : ""}${inApp ? "&app=1" : ""}`;
    if (ctx.mailer.driver === "log") return reply.code(200).send({ devLink: link });
    try {
      await ctx.mailer.send(signInEmail(email, link));
    } catch (err) {
      ctx.log.error({ err }, "sign-in email failed");
      throw new HttpError(502, "email_failed", "We couldn't send the sign-in email. Try again in a moment.");
    }
    return reply.code(204).send();
  });

  app.post("/api/auth/verify", async (req) => {
    const token = requiredString(body(req.body), "token", 200);
    await enforce(ctx.sql, ctx.log, `verify-ip:${req.ip}`, LIMITS.verifyIp);
    const [login] = await ctx.sql<{ email: string }[]>`
      update login_tokens set used_at = now()
      where token_hash = ${sha256(token)} and used_at is null and expires_at > now()
      returning email`;
    if (!login) throw unauthorized("This sign-in link has expired or was already used. Request a new one.");
    const [user] = await ctx.sql<Director[]>`
      insert into users (email) values (${login.email})
      on conflict (email) do update set email = excluded.email
      returning id, email, name`;
    const sessionToken = randomToken();
    await ctx.sql`insert into sessions (token_hash, user_id, expires_at)
                  values (${sha256(sessionToken)}, ${user!.id}, now() + ${SESSION_DAYS} * interval '1 day')`;
    return { sessionToken, user };
  });

  app.get("/api/me", async (req) => ({ user: await requireDirector(ctx, req) }));

  app.patch("/api/me", async (req) => {
    const director = await requireDirector(ctx, req);
    const name = optionalString(body(req.body), "name", 80);
    if (name === undefined) return { user: director };
    const [user] = await ctx.sql`update users set name = ${name} where id = ${director.id}
      returning id, email, name`;
    return { user };
  });

  // Deletes the account and everything in it, for good (App Store guideline 5.1.1(v)). The body must
  // say { confirm: true }, so a stray request can't do it.
  app.delete("/api/me", async (req, reply) => {
    const director = await requireDirector(ctx, req);
    if (body(req.body).confirm !== true) throw new HttpError(400, "confirm_required", "Confirm that you want to delete your account.");
    await deleteAccount(ctx, director.id);
    return reply.code(204).send();
  });

  app.post("/api/auth/logout", async (req, reply) => {
    await requireDirector(ctx, req);
    const token = req.headers.authorization!.split(/\s+/, 2)[1]!;
    await ctx.sql`delete from sessions where token_hash = ${sha256(token)}`;
    return reply.code(204).send();
  });
}
