import type { ActorSession } from "../auth.ts";
import type { Ctx } from "../context.ts";
import { hmac, isUuid, safeEqual } from "../crypto.ts";
import { HttpError } from "../errors.ts";
import { enforce, LIMITS } from "../ratelimit.ts";
import { verifyEmailEmail } from "./templates.ts";

// A cast member's email counts only once they confirm it from the link sent to it (the link opens a
// page with a Confirm button; the button's POST verifies). The link is signed like the unsubscribe
// link (SESSION_SECRET), names the actor, the address and when it was sent, and works for
// VERIFY_LINK_DAYS while that address is still the one waiting (a newer address replaces it).
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
  sent: boolean; // this request sent a verification email
}

// Sends the verification link to `email` (or again to the address already waiting) and keeps the
// address as pending until it is confirmed. The verified address, if any, stays until then. Nothing
// to send (no address waiting, or the address given is the verified one) answers with the current
// state and sends nothing. Limits: per cast member, per address, per production and per IP, so a
// made-up production can't be used to send many of them.
export async function requestVerification(ctx: Ctx, s: ActorSession, given: string | null | undefined, ip: string): Promise<EmailState & { devLink?: string }> {
  const { sql, log } = ctx;
  const email = given || s.actor.pendingEmail;
  if (!email || email === s.actor.email) {
    if (email) await sql`update actors set pending_email = null, pending_email_sent_at = null where id = ${s.actor.id}`;
    return { hasEmail: Boolean(s.actor.email), pendingEmail: false, sent: false };
  }
  const wait = "Too many emails sent. Wait a few minutes and try again.";
  await enforce(sql, log, `verify-send:${s.actor.id}`, LIMITS.verifySend, wait);
  await enforce(sql, log, `verify-to:${email}`, LIMITS.verifyTo, "Too many emails to that address today. Try again tomorrow.");
  await enforce(sql, log, `verify-production:${s.production.id}`, LIMITS.verifyProduction, wait);
  await enforce(sql, log, `verify-send-ip:${ip}`, LIMITS.verifySendIp, wait);
  const link = verifyLink(ctx, s.actor.id, email);
  try {
    await ctx.mailer.send(verifyEmailEmail(email, { title: s.production.title, url: link }));
  } catch (err) {
    log.error({ err }, "verification email failed");
    throw new HttpError(502, "email_failed", "We couldn't send the email. Try again in a moment.");
  }
  await sql`update actors set pending_email = ${email}, pending_email_sent_at = now() where id = ${s.actor.id}`;
  return { hasEmail: Boolean(s.actor.email), pendingEmail: true, sent: true, ...(ctx.mailer.driver === "log" ? { devLink: link } : {}) };
}

export interface LinkStatus {
  state: "waiting" | "confirmed"; // waiting: the address still needs its Confirm tap
  title: string;
  unsubscribed: boolean; // the address unsubscribed from Offbooked emails earlier
}

// What a link points at, changing nothing: opening it (GET) only shows the Confirm button, so a mail
// scanner that follows links verifies nothing. Null when the address is no longer the one waiting.
export async function linkStatus(ctx: Ctx, link: { actorId: string; email: string }): Promise<LinkStatus | null> {
  const [row] = await ctx.sql<{ waiting: boolean; title: string; unsubscribed: boolean }[]>`
    select a.pending_email = ${link.email} as waiting, p.title,
      exists (select 1 from email_unsubscribes u where u.email = ${link.email}) as unsubscribed
    from actors a join productions p on p.id = a.production_id
    where a.id = ${link.actorId}
      and (a.pending_email = ${link.email} or (a.email = ${link.email} and a.email_verified_at is not null))`;
  return row ? { state: row.waiting ? "waiting" : "confirmed", title: row.title, unsubscribed: row.unsubscribed } : null;
}

// The Confirm tap (POST): the waiting address becomes the verified one. A second tap still confirms.
// An earlier unsubscribe stays unless the page said so and the tap asked to turn updates back on.
export async function confirmVerification(ctx: Ctx, link: { actorId: string; email: string }, resubscribe: boolean): Promise<LinkStatus | null> {
  const { sql } = ctx;
  await sql`
    update actors set email = pending_email, email_verified_at = now(), pending_email = null, pending_email_sent_at = null
    where id = ${link.actorId} and pending_email = ${link.email}`;
  const status = await linkStatus(ctx, link);
  if (status && resubscribe && status.unsubscribed) {
    await sql`delete from email_unsubscribes where email = ${link.email}`;
    return { ...status, unsubscribed: false };
  }
  return status;
}
