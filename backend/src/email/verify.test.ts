import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { after, before, describe, test } from "node:test";
import type { Ctx } from "../context.ts";
import { SEED_SCENE } from "../seed-scene.ts";
import { bearer, createTestApp, dbSkip, invite, productionWithScript, signIn, type TestApp } from "../test/helpers.ts";
import { notifyCastComplete } from "./notify.ts";
import { readVerifyLink, VERIFY_LINK_DAYS, verifyLink } from "./verify.ts";

const fakeCtx = { config: { sessionSecret: "secret", apiUrl: "http://api.test" } } as Ctx;
const ACTOR = "0b5c3f0e-2b7c-4a43-9d7e-1f6a1d2c3b4a";
const query = (link: string) => Object.fromEntries(new URL(link).searchParams);

describe("verification links", () => {
  test("name the actor and address, and refuse tampering and old links", () => {
    const now = Date.parse("2026-10-20T12:00:00Z");
    const link = verifyLink(fakeCtx, ACTOR, "Riz@Example.test", now);
    assert.ok(link.startsWith("http://api.test/api/email/verify?"));
    assert.deepEqual(readVerifyLink(fakeCtx, query(link), now), { actorId: ACTOR, email: "riz@example.test" });

    const q = query(link);
    assert.equal(readVerifyLink(fakeCtx, { ...q, e: Buffer.from("eve@example.test").toString("base64url") }, now), null, "another address");
    assert.equal(readVerifyLink(fakeCtx, { ...q, a: "1b5c3f0e-2b7c-4a43-9d7e-1f6a1d2c3b4a" }, now), null, "another actor");
    assert.equal(readVerifyLink(fakeCtx, { ...q, t: String(Number(q.t) + 60) }, now), null, "another time");
    assert.equal(readVerifyLink(fakeCtx, { ...q, a: "not-a-uuid" }, now), null);
    assert.equal(readVerifyLink(fakeCtx, { ...q, s: undefined }, now), null);
    const other = { config: { sessionSecret: "other", apiUrl: "http://api.test" } } as Ctx;
    assert.equal(readVerifyLink(other, q, now), null, "signed with the session secret");

    const day = 86_400_000;
    assert.ok(readVerifyLink(fakeCtx, q, now + VERIFY_LINK_DAYS * day - 1000), "works for a week");
    assert.equal(readVerifyLink(fakeCtx, q, now + VERIFY_LINK_DAYS * day + 1000), null, "then expires");
  });
});

describe("cast member email verification", { skip: dbSkip }, () => {
  let t: TestApp;
  let director: string;
  let pid: string;
  let riz: { id: string; inviteUrl: string };
  let jo: { id: string; inviteUrl: string };

  const contact = (who: { inviteUrl: string }, email?: string) =>
    t.app.inject({ method: "POST", url: "/api/invite/contact", headers: invite(who.inviteUrl), payload: email === undefined ? {} : { email } });
  const state = async (who: { inviteUrl: string }) => {
    const body = (await t.app.inject({ method: "GET", url: "/api/invite", headers: invite(who.inviteUrl) })).json();
    return { hasEmail: body.hasEmail, pendingEmail: body.pendingEmail };
  };
  const open = (link: string) => {
    const u = new URL(link);
    return t.app.inject({ method: "GET", url: u.pathname + u.search });
  };
  const sentTo = (to: string) => t.mailer.sent.filter((m) => m.to === to);

  before(async () => {
    t = await createTestApp();
    director = await signIn(t, "director@example.test");
    const made = await productionWithScript(t, director, SEED_SCENE, "Hamlet");
    pid = made.id;
    const char = (name: string) => made.script.characters.find((c: { name: string }) => c.name === name).id;
    const cast = async (name: string, characterIds: string[]) =>
      (await t.app.inject({ method: "POST", url: `/api/productions/${pid}/cast`, headers: bearer(director), payload: { name, characterIds } })).json().member;
    riz = await cast("Riz", [char("HAMLET")]);
    jo = await cast("Jo", [char("HORATIO")]);
  });
  after(() => t.close());

  test("an address counts only once its link is opened", async () => {
    assert.deepEqual(await state(riz), { hasEmail: false, pendingEmail: false });
    assert.equal((await contact(riz)).statusCode, 400, "nothing to send again yet");
    assert.equal((await contact(riz, "not-an-email")).statusCode, 400);

    const first = await contact(riz, "Riz@Example.test");
    assert.equal(first.statusCode, 200);
    const { devLink, ...sent } = first.json() as { hasEmail: boolean; pendingEmail: boolean; devLink: string };
    assert.deepEqual(sent, { hasEmail: false, pendingEmail: true });
    assert.ok(devLink, "the log driver hands back the link, like a sign-in link");
    assert.deepEqual(await state(riz), { hasEmail: false, pendingEmail: true });
    const [mail] = sentTo("riz@example.test");
    assert.equal(mail!.subject, "Confirm your email for Offbooked");
    assert.ok(mail!.text.includes(first.json().devLink), "the email carries the link");
    assert.ok(mail!.html.includes("Hamlet"));

    // "Send it again" resends to the address waiting; a new address replaces it and its old link.
    const again = await contact(riz);
    assert.equal(again.statusCode, 200);
    assert.equal(sentTo("riz@example.test").length, 2);
    const changed = await contact(riz, "riz.ahmed@example.test");
    assert.equal((await open(again.json().devLink)).statusCode, 410, "an address no longer waiting");
    assert.deepEqual(await state(riz), { hasEmail: false, pendingEmail: true });

    const opened = await open(changed.json().devLink);
    assert.equal(opened.statusCode, 200);
    assert.match(opened.headers["content-type"] as string, /text\/html/);
    assert.match(opened.body, /Email confirmed/);
    assert.match(opened.body, /Hamlet is ready to listen through/);
    assert.deepEqual(await state(riz), { hasEmail: true, pendingEmail: false });
    const [row] = await t.ctx.sql<{ email: string; emailVerifiedAt: Date | null }[]>`select email, email_verified_at from actors where id = ${riz.id}`;
    assert.equal(row!.email, "riz.ahmed@example.test");
    assert.ok(row!.emailVerifiedAt);
    assert.equal((await open(changed.json().devLink)).statusCode, 200, "a second tap (or a mail scanner first) still confirms");

    // The verified address stays while a new one waits; asking for the verified one again sends nothing.
    await contact(riz, "riz.new@example.test");
    assert.deepEqual(await state(riz), { hasEmail: true, pendingEmail: true });
    const before = t.mailer.sent.length;
    const same = await contact(riz, "riz.ahmed@example.test");
    assert.deepEqual(same.json(), { hasEmail: true, pendingEmail: false });
    assert.equal(t.mailer.sent.length, before);
    assert.deepEqual(await state(riz), { hasEmail: true, pendingEmail: false });
  });

  test("tampered links are refused with a plain page", async () => {
    const link = new URL((await contact(jo, "jo@example.test")).json().devLink);
    link.searchParams.set("e", Buffer.from("eve@example.test").toString("base64url"));
    const res = await open(link.toString());
    assert.equal(res.statusCode, 410);
    assert.match(res.body, /This link has expired/);
    assert.equal((await open("http://api.test/api/email/verify")).statusCode, 410);
    assert.deepEqual(await state(jo), { hasEmail: false, pendingEmail: true });
  });

  test("sends are rate limited per cast member and per address", async () => {
    await t.ctx.sql`delete from rate_limits`;
    const codes = [];
    for (let i = 0; i < 6; i++) codes.push((await contact(jo, `jo${i}@example.test`)).statusCode);
    assert.deepEqual(codes, [200, 200, 200, 200, 200, 429]);

    await t.ctx.sql`delete from rate_limits`;
    const target = "target@example.test";
    for (let i = 0; i < 5; i++) {
      await t.ctx.sql`delete from rate_limits where key like 'verify-send:%'`;
      assert.equal((await contact(i % 2 ? jo : riz, target)).statusCode, 200);
    }
    await t.ctx.sql`delete from rate_limits where key like 'verify-send:%'`;
    const flooded = await contact(jo, target);
    assert.equal(flooded.statusCode, 429);
    assert.equal(flooded.json().error.code, "rate_limited");
    await t.ctx.sql`delete from rate_limits`;
  });

  test("only verified addresses hear the play is ready, and verifying lifts an old unsubscribe", async () => {
    await t.ctx.sql`insert into email_unsubscribes (email) values ('riz.home@example.test')`;
    const link = (await contact(riz, "riz.home@example.test")).json().devLink;
    assert.equal((await open(link)).statusCode, 200);
    assert.equal((await t.ctx.sql`select 1 from email_unsubscribes where email = 'riz.home@example.test'`).length, 0);

    // Jo only has an address waiting for its link.
    assert.deepEqual(await state(jo), { hasEmail: false, pendingEmail: true });
    await notifyCastComplete(t.ctx, pid);
    const ready = t.mailer.sent.filter((m) => m.subject === "Hamlet is ready to listen through").map((m) => m.to);
    assert.deepEqual(ready, ["riz.home@example.test"]);
  });

  test("the migration keeps addresses left before verification as verified", async () => {
    const [legacy] = await t.ctx.sql<{ id: string }[]>`
      insert into actors (production_id, name, email) values (${pid}, 'Old', 'old@example.test') returning id`;
    const [blank] = await t.ctx.sql<{ id: string }[]>`insert into actors (production_id, name, email) values (${pid}, 'Blank', ' ') returning id`;
    await t.ctx.sql.unsafe(await readFile(new URL("../../migrations/015_actor_email_verification.sql", import.meta.url), "utf8"));
    const rows = await t.ctx.sql<{ id: string; emailVerifiedAt: Date | null }[]>`
      select id, email_verified_at from actors where id in (${legacy!.id}, ${blank!.id})`;
    assert.ok(rows.find((r) => r.id === legacy!.id)!.emailVerifiedAt, "an address already left counts");
    assert.equal(rows.find((r) => r.id === blank!.id)!.emailVerifiedAt, null, "a blank one doesn't");
  });
});
