import type { FastifyInstance } from "fastify";
import { requireDirector, SESSION_DAYS } from "../auth.ts";
import type { Ctx } from "../context.ts";
import { randomToken, sha256 } from "../crypto.ts";
import { HttpError, unauthorized } from "../errors.ts";
import { signInEmail } from "../email/templates.ts";
import { body, optionalString, requiredEmail, requiredString } from "../input.ts";
import { enforce, LIMITS } from "../ratelimit.ts";

const LOGIN_TOKEN_MINUTES = 15;

export function authRoutes(app: FastifyInstance, ctx: Ctx) {
  app.post("/api/auth/request", async (req, reply) => {
    const email = requiredEmail(body(req.body), "email");
    await enforce(ctx.sql, ctx.log, `signin-ip:${req.ip}`, LIMITS.signInIp);
    await enforce(ctx.sql, ctx.log, `signin-email:${email}`, LIMITS.signInEmail, "Too many sign-in links for this email. Wait a few minutes and try again.");
    const token = randomToken();
    await ctx.sql`insert into login_tokens (token_hash, email, expires_at)
                  values (${sha256(token)}, ${email}, now() + ${LOGIN_TOKEN_MINUTES} * interval '1 minute')`;
    const link = `${ctx.config.appUrl}/auth/verify?token=${token}`;
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
    const [user] = await ctx.sql<{ id: string; email: string; name: string | null }[]>`
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
    const [user] = await ctx.sql`update users set name = ${name} where id = ${director.id} returning id, email, name`;
    return { user };
  });

  app.post("/api/auth/logout", async (req, reply) => {
    await requireDirector(ctx, req);
    const token = req.headers.authorization!.split(/\s+/, 2)[1]!;
    await ctx.sql`delete from sessions where token_hash = ${sha256(token)}`;
    return reply.code(204).send();
  });
}
