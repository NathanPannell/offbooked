import type { Ctx } from "../context.ts";
import { hmac, safeEqual } from "../crypto.ts";
import { inviteUrl } from "../invite.ts";
import { castFacingName } from "../names.ts";
import { consume, LIMITS } from "../ratelimit.ts";
import type { Email } from "./mailer.ts";
import { actorDoneEmail, castCompleteEmail, runthroughReadyEmail } from "./templates.ts";

type Kind = "actor_done" | "cast_complete" | "runthrough_ready";

// Sends each (kind, production, actor) at most once. Failures are logged and recorded, never thrown.
async function sendOnce(
  ctx: Ctx,
  n: { kind: Kind; productionId: string; actorId: string | null; to: string | null },
  build: (to: string) => Email,
): Promise<void> {
  const { sql, log } = ctx;
  if (!n.to) return;
  try {
    if (n.kind === "runthrough_ready") {
      const [unsubscribed] = await sql`select 1 from email_unsubscribes where email = ${n.to.toLowerCase()}`;
      if (unsubscribed) return;
    }
    const [row] = await sql<{ id: string }[]>`
      insert into notifications (kind, production_id, actor_id, recipient) values (${n.kind}, ${n.productionId}, ${n.actorId}, ${n.to})
      on conflict on constraint notifications_once do nothing returning id`;
    if (!row) return;
    if (!(await consume(sql, `email:${n.productionId}`, LIMITS.completionEmail))) {
      log.warn({ kind: n.kind, productionId: n.productionId }, "completion email rate limited");
      await sql`update notifications set error = 'rate_limited' where id = ${row.id}`;
      return;
    }
    try {
      await ctx.mailer.send(build(n.to));
      await sql`update notifications set sent_at = now() where id = ${row.id}`;
    } catch (err) {
      log.error({ err, kind: n.kind, productionId: n.productionId }, "notification email failed");
      await sql`update notifications set error = ${String((err as Error).message).slice(0, 500)} where id = ${row.id}`;
    }
  } catch (err) {
    log.error({ err, kind: n.kind }, "notification bookkeeping failed");
  }
}

interface ProductionInfo {
  title: string;
  ownerEmail: string;
  ownerName: string | null;
}

async function productionInfo(ctx: Ctx, productionId: string): Promise<ProductionInfo | undefined> {
  const [p] = await ctx.sql<ProductionInfo[]>`
    select p.title, u.email as owner_email, u.name as owner_name from productions p join users u on u.id = p.owner_id where p.id = ${productionId}`;
  return p;
}

export async function notifyActorDone(
  ctx: Ctx,
  productionId: string,
  actor: { id: string; name: string; firstName: string | null; linesTotal: number },
): Promise<void> {
  const p = await productionInfo(ctx, productionId);
  if (!p) return;
  // No "you finished your lines" email when the director recorded the part themselves.
  const [own] = await ctx.sql`select 1 from actors where id = ${actor.id} and director_user_id is not null`;
  if (own) return;
  const name = actor.firstName || actor.name;
  await sendOnce(ctx, { kind: "actor_done", productionId, actorId: actor.id, to: p.ownerEmail }, (to) =>
    actorDoneEmail(to, { actorName: name, lines: actor.linesTotal, title: p.title, url: `${ctx.config.appUrl}/app/p/${productionId}` }),
  );
}

export async function notifyCastComplete(ctx: Ctx, productionId: string): Promise<void> {
  const p = await productionInfo(ctx, productionId);
  if (!p) return;
  await sendOnce(ctx, { kind: "cast_complete", productionId, actorId: null, to: p.ownerEmail }, (to) =>
    castCompleteEmail(to, { title: p.title, url: `${ctx.config.appUrl}/app/p/${productionId}` }),
  );
  const actors = await ctx.sql<{ id: string; email: string | null; tokenVersion: number }[]>`
    select id, email, token_version from actors where production_id = ${productionId} and email is not null`;
  for (const a of actors) {
    await sendOnce(ctx, { kind: "runthrough_ready", productionId, actorId: a.id, to: a.email }, (to) =>
      runthroughReadyEmail(to, {
        title: p.title,
        directorName: castFacingName(p.ownerName, p.ownerEmail),
        url: `${inviteUrl(ctx.config.appUrl, ctx.config.inviteSecret, a.id, a.tokenVersion)}/play`,
        unsubscribeUrl: unsubscribeUrl(ctx, to),
      }),
    );
  }
}

export function unsubscribeUrl(ctx: Ctx, email: string): string {
  const e = Buffer.from(email.toLowerCase()).toString("base64url");
  return `${ctx.config.apiUrl}/api/email/unsubscribe?e=${e}&s=${hmac(ctx.config.sessionSecret, `unsubscribe:${e}`).slice(0, 32)}`;
}

export function verifyUnsubscribe(ctx: Ctx, e: string, s: string): string | null {
  if (!safeEqual(s, hmac(ctx.config.sessionSecret, `unsubscribe:${e}`).slice(0, 32))) return null;
  return Buffer.from(e, "base64url").toString("utf8");
}
