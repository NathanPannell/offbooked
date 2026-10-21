import type { Ctx } from "../context.ts";
import { hmac, safeEqual } from "../crypto.ts";
import { inviteUrl } from "../invite.ts";
import { castFacingName } from "../names.ts";
import { consume, LIMITS } from "../ratelimit.ts";
import { castRows } from "../views.ts";
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

// After any take: tells the director about each cast member whose parts are now fully recorded and
// who hasn't had the email yet. Lines count whoever recorded them, the director included, but only
// someone who has recorded at least one of those lines themselves gets one: not a pick on a second
// phone, nor someone whose part others recorded. The director's own cast member (from before parts
// were open) never gets one.
export async function notifyActorsDone(ctx: Ctx, productionId: string): Promise<void> {
  const done = (await castRows(ctx.sql, { productionId })).filter((a) => a.linesTotal > 0 && a.linesRecorded >= a.linesTotal);
  if (!done.length) return;
  const skip = new Set(
    (
      await ctx.sql<{ id: string }[]>`
        select a.id from actors a where a.id = any(${done.map((a) => a.id)}::uuid[])
          and (a.director_user_id is not null
               or exists (select 1 from notifications n where n.kind = 'actor_done' and n.actor_id = a.id)
               or not exists (select 1 from takes t join line_voices lv on lv.line_id = t.line_id
                              join actor_characters ac on ac.character_id = lv.character_id and ac.actor_id = a.id
                              where t.actor_id = a.id and t.deleted_at is null))`
    ).map((r) => r.id),
  );
  const p = await productionInfo(ctx, productionId);
  if (!p) return;
  for (const a of done) {
    if (skip.has(a.id)) continue;
    await sendOnce(ctx, { kind: "actor_done", productionId, actorId: a.id, to: p.ownerEmail }, (to) =>
      actorDoneEmail(to, { actorName: a.firstName || a.name, lines: a.linesTotal, title: p.title, url: `${ctx.config.appUrl}/app/p/${productionId}` }),
    );
  }
}

export async function notifyCastComplete(ctx: Ctx, productionId: string): Promise<void> {
  const p = await productionInfo(ctx, productionId);
  if (!p) return;
  await sendOnce(ctx, { kind: "cast_complete", productionId, actorId: null, to: p.ownerEmail }, (to) =>
    castCompleteEmail(to, { title: p.title, url: `${ctx.config.appUrl}/app/p/${productionId}` }),
  );
  const actors = await ctx.sql<{ id: string; email: string | null; tokenVersion: number }[]>`
    select id, email, token_version from actors
    where production_id = ${productionId} and email_verified_at is not null and coalesce(btrim(email), '') <> ''`;
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
