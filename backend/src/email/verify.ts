import type { ActorSession } from "../auth.ts";
import type { Ctx } from "../context.ts";
import { hmac, isUuid, safeEqual } from "../crypto.ts";
import { badRequest, HttpError } from "../errors.ts";
import { enforce, LIMITS } from "../ratelimit.ts";
import { verifyEmailEmail } from "./templates.ts";

// A cast member's email counts only once they open the link sent to it. The link is signed like the
// unsubscribe link (SESSION_SECRET), names the actor, the address and when it was sent, and works
// for VERIFY_LINK_DAYS while that address is still the one waiting (a newer address replaces it).
export const VERIFY_LINK_DAYS = 7;
const DAY_S = 86_400;

const signature = (ctx: Ctx, a: string, e: string, t: string) => hmac(ctx.config.sessionSecret, `verify-email:${a.toLowerCase()}:${e}:${t}`).slice(0, 32);

export function verifyLink(ctx: Ctx, actorId: string, email: string, now = Date.now()): string {
  const e = Buffer.from(email.toLowerCase()).toString("base64url");
  const t = String(Math.floor(now / 1000));
  return `${ctx.config.apiUrl}/api/email/verify?a=${actorId}&e=${e}&t=${t}&s=${signature(ctx, actorId, e, t)}`;
}

// The actor and address a link was signed for, or null when it was tampered with or has expired.
export function readVerifyLink(ctx: Ctx, q: { a?: string; e?: string; t?: string; s?: string }, now = Date.now()): { actorId: string; email: string } | null {
  const { a, e, t, s } = q;
  if (!a || !e || !t || !s || !isUuid(a) || !/^\d{1,12}$/.test(t)) return null;
  if (!safeEqual(s, signature(ctx, a, e, t))) return null;
  if (now / 1000 - Number(t) > VERIFY_LINK_DAYS * DAY_S) return null;
  return { actorId: a.toLowerCase(), email: Buffer.from(e, "base64url").toString("utf8") };
}

export interface EmailState {
  hasEmail: boolean; // a verified address: the only kind that gets email or keeps details after the show
  pendingEmail: boolean; // an address waiting for its link
}

// Sends the verification link to `email` (or again to the address already waiting) and keeps the
// address as pending until it is opened. The verified address, if any, stays until then.
export async function requestVerification(ctx: Ctx, s: ActorSession, given: string | null | undefined): Promise<EmailState & { devLink?: string }> {
  const { sql, log } = ctx;
  const email = given || s.actor.pendingEmail;
  if (!email) throw badRequest("Enter an email address.");
  if (email === s.actor.email) {
    await sql`update actors set pending_email = null, pending_email_sent_at = null where id = ${s.actor.id}`;
    return { hasEmail: true, pendingEmail: false };
  }
  await enforce(sql, log, `verify-send:${s.actor.id}`, LIMITS.verifySend, "Too many emails sent. Wait a few minutes and try again.");
  await enforce(sql, log, `verify-to:${email}`, LIMITS.verifyTo, "Too many emails to that address today. Try again tomorrow.");
  const link = verifyLink(ctx, s.actor.id, email);
  try {
    await ctx.mailer.send(verifyEmailEmail(email, { title: s.production.title, url: link }));
  } catch (err) {
    log.error({ err }, "verification email failed");
    throw new HttpError(502, "email_failed", "We couldn't send the email. Try again in a moment.");
  }
  await sql`update actors set pending_email = ${email}, pending_email_sent_at = now() where id = ${s.actor.id}`;
  return { hasEmail: Boolean(s.actor.email), pendingEmail: true, ...(ctx.mailer.driver === "log" ? { devLink: link } : {}) };
}

// Opening the link: the waiting address becomes the verified one. Opening it again (a second tap,
// or a mail scanner first) still confirms. Asking for emails again also lifts an old unsubscribe.
export async function confirmVerification(ctx: Ctx, link: { actorId: string; email: string }): Promise<{ title: string } | null> {
  const { sql } = ctx;
  const [row] = await sql<{ title: string }[]>`
    with done as (
      update actors set email = pending_email, email_verified_at = now(), pending_email = null, pending_email_sent_at = null
      where id = ${link.actorId} and pending_email = ${link.email}
      returning production_id)
    select p.title from done join productions p on p.id = done.production_id`;
  if (row) {
    await sql`delete from email_unsubscribes where email = ${link.email}`;
    return row;
  }
  const [already] = await sql<{ title: string }[]>`
    select p.title from actors a join productions p on p.id = a.production_id
    where a.id = ${link.actorId} and a.email = ${link.email} and a.email_verified_at is not null`;
  return already ?? null;
}
