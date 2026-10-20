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

  const contact = (who: { inviteUrl: string }, email?: string, ip = "127.0.0.1") =>
    t.app.inject({
      method: "POST",
      url: "/api/invite/contact",
      headers: { ...invite(who.inviteUrl), "x-forwarded-for": ip },
      payload: email === undefined ? {} : { email },
    });
  const state = async (who: { inviteUrl: string }) => {
    const body = (await t.app.inject({ method: "GET", url: "/api/invite", headers: invite(who.inviteUrl) })).json();
    return { hasEmail: body.hasEmail, pendingEmail: body.pendingEmail };
  };
  // Opening the link (GET) only shows the page; its Confirm button posts the same fields as a form.
  const open = (link: string, ip = "127.0.0.1") => {
    const u = new URL(link);
    return t.app.inject({ method: "GET", url: u.pathname + u.search, headers: { "x-forwarded-for": ip } });
  };
  const confirm = (link: string, extra: Record<string, string> = {}) => {
    const u = new URL(link);
    return t.app.inject({
      method: "POST",
      url: u.pathname,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: new URLSearchParams({ ...Object.fromEntries(u.searchParams), ...extra }).toString(),
    });
  };
  const sentTo = (to: string) => t.mailer.sent.filter((m) => m.to === to);

  before(async () => {
    t = await createTestApp();
    director = await signIn(t, "director@example.test");
    const made = await productionWithScript(t, director, SEED_SCENE, "Hamlet <b>now</b>");
    pid = made.id;
    const char = (name: string) => made.script.characters.find((c: { name: string }) => c.name === name).id;
    const cast = async (name: string, characterIds: string[]) =>
      (await t.app.inject({ method: "POST", url: `/api/productions/${pid}/cast`, headers: bearer(director), payload: { name, characterIds } })).json().member;
    riz = await cast("Riz", [char("HAMLET")]);
    jo = await cast("Jo", [char("HORATIO")]);
  });
  after(() => t.close());

  test("an address counts only once it is confirmed from its link", async () => {
    assert.deepEqual(await state(riz), { hasEmail: false, pendingEmail: false });
    const nothing = await contact(riz);
    assert.equal(nothing.statusCode, 200, "nothing to send again: the current state, no email");
    assert.deepEqual(nothing.json(), { hasEmail: false, pendingEmail: false, sent: false });
    assert.equal((await contact(riz, "not-an-email")).statusCode, 400);

    const first = await contact(riz, "Riz@Example.test");
    assert.equal(first.statusCode, 200);
    const { devLink, ...sent } = first.json() as { hasEmail: boolean; pendingEmail: boolean; sent: boolean; devLink: string };
    assert.deepEqual(sent, { hasEmail: false, pendingEmail: true, sent: true });
    assert.ok(devLink, "the log driver hands back the link, like a sign-in link");
    assert.deepEqual(await state(riz), { hasEmail: false, pendingEmail: true });
    const [mail] = sentTo("riz@example.test");
    assert.equal(mail!.subject, "Confirm your email for Offbooked", "the production's title stays out of the subject");
    assert.ok(mail!.text.includes(devLink), "the email carries the link");
    assert.ok(mail!.html.includes("Hamlet &lt;b&gt;now&lt;/b&gt;") && !mail!.html.includes("<b>now"), "the title is escaped in the body");

    // "Send it again" resends to the address waiting; a new address replaces it and its old link.
    const again = await contact(riz);
    assert.equal(again.statusCode, 200);
    assert.equal(sentTo("riz@example.test").length, 2);
    const changed = await contact(riz, "riz.ahmed@example.test");
    assert.equal((await open(again.json().devLink)).statusCode, 410, "an address no longer waiting");
    assert.equal((await confirm(again.json().devLink)).statusCode, 410);
    assert.deepEqual(await state(riz), { hasEmail: false, pendingEmail: true });

    // Opening the link (or a mail scanner following it) changes nothing: it shows the Confirm button.
    const opened = await open(changed.json().devLink);
    assert.equal(opened.statusCode, 200);
    assert.match(opened.headers["content-type"] as string, /text\/html/);
    assert.match(opened.body, /<form method="post" action="\/api\/email\/verify">/);
    assert.match(opened.body, /Confirm my email/);
    assert.doesNotMatch(opened.body, /<b>now/, "the title is escaped on the page");
    assert.deepEqual(await state(riz), { hasEmail: false, pendingEmail: true });

    const confirmed = await confirm(changed.json().devLink);
    assert.equal(confirmed.statusCode, 200);
    assert.match(confirmed.body, /Email confirmed/);
    assert.match(confirmed.body, /is ready to listen through/);
    assert.deepEqual(await state(riz), { hasEmail: true, pendingEmail: false });
    const [row] = await t.ctx.sql<{ email: string; emailVerifiedAt: Date | null }[]>`select email, email_verified_at from actors where id = ${riz.id}`;
    assert.equal(row!.email, "riz.ahmed@example.test");
    assert.ok(row!.emailVerifiedAt);
    assert.equal((await confirm(changed.json().devLink)).statusCode, 200, "a second tap still confirms");
    assert.match((await open(changed.json().devLink)).body, /Email confirmed/, "and the link then says so");

    // The verified address stays while a new one waits; giving the verified one again sends nothing.
    await contact(riz, "riz.new@example.test");
    assert.deepEqual(await state(riz), { hasEmail: true, pendingEmail: true });
    const before = t.mailer.sent.length;
    const same = await contact(riz, "riz.ahmed@example.test");
    assert.deepEqual(same.json(), { hasEmail: true, pendingEmail: false, sent: false });
    assert.equal(t.mailer.sent.length, before);
    assert.deepEqual(await state(riz), { hasEmail: true, pendingEmail: false });
    // "Send it again" from a stale screen, after verifying in another tab: the current state, no email.
    assert.deepEqual((await contact(riz)).json(), { hasEmail: true, pendingEmail: false, sent: false });
    assert.equal(t.mailer.sent.length, before);
  });

  test("tampered links are refused with a plain page", async () => {
    const link = new URL((await contact(jo, "jo@example.test")).json().devLink);
    link.searchParams.set("e", Buffer.from("eve@example.test").toString("base64url"));
    const res = await open(link.toString());
    assert.equal(res.statusCode, 410);
    assert.match(res.body, /This link has expired/);
    assert.equal((await confirm(link.toString())).statusCode, 410);
    assert.equal((await open("http://api.test/api/email/verify")).statusCode, 410);
    assert.deepEqual(await state(jo), { hasEmail: false, pendingEmail: true });
  });

  test("opening links too often gets a friendly page, not JSON", async () => {
    const link = (await contact(jo)).json().devLink;
    const codes = [];
    for (let i = 0; i < 31; i++) codes.push((await open(link, "10.9.9.9")).statusCode);
    assert.deepEqual([...new Set(codes)], [200, 429]);
    const limited = await open(link, "10.9.9.9");
    assert.equal(limited.statusCode, 429);
    assert.match(limited.headers["content-type"] as string, /text\/html/);
    assert.match(limited.body, /Too many tries/);
  });

  test("sends are rate limited per cast member, address, production and IP", async () => {
    const clear = (prefix: string) => t.ctx.sql`delete from rate_limits where key like ${prefix + "%"}`;
    await t.ctx.sql`delete from rate_limits`;
    const codes = [];
    for (let i = 0; i < 6; i++) codes.push((await contact(jo, `jo${i}@example.test`)).statusCode);
    assert.deepEqual(codes, [200, 200, 200, 200, 200, 429], "per cast member");

    await t.ctx.sql`delete from rate_limits`;
    const target = "target@example.test";
    for (let i = 0; i < 5; i++) {
      await clear("verify-send:");
      assert.equal((await contact(i % 2 ? jo : riz, target, `10.0.0.${i}`)).statusCode, 200);
    }
    await clear("verify-send:");
    const flooded = await contact(jo, target, "10.0.1.1");
    assert.equal(flooded.statusCode, 429, "per address");
    assert.equal(flooded.json().error.code, "rate_limited");

    await t.ctx.sql`delete from rate_limits`;
    for (let i = 0; i < 10; i++) {
      await clear("verify-send:");
      assert.equal((await contact(i % 2 ? jo : riz, `ip${i}@example.test`, "10.0.2.2")).statusCode, 200);
    }
    await clear("verify-send:");
    assert.equal((await contact(jo, "ip-more@example.test", "10.0.2.2")).statusCode, 429, "per IP");

    await t.ctx.sql`delete from rate_limits`;
    for (let i = 0; i < 20; i++) {
      await clear("verify-send:");
      assert.equal((await contact(i % 2 ? jo : riz, `p${i}@example.test`, `10.1.0.${i}`)).statusCode, 200);
    }
    await clear("verify-send:");
    assert.equal((await contact(jo, "p-more@example.test", "10.1.1.1")).statusCode, 429, "per production");
    await t.ctx.sql`delete from rate_limits`;
  });

  test("only verified addresses hear the play is ready; an unsubscribe is lifted only when confirming says so", async () => {
    await t.ctx.sql`insert into email_unsubscribes (email) values ('riz.home@example.test')`;
    const link = (await contact(riz, "riz.home@example.test")).json().devLink;
    const opened = await open(link);
    assert.match(opened.body, /You'd unsubscribed from Offbooked emails; confirming turns updates back on\./);
    assert.match(opened.body, /name="resubscribe" value="1"/);
    const unsubscribed = async () => (await t.ctx.sql`select 1 from email_unsubscribes where email = 'riz.home@example.test'`).length === 1;
    assert.equal(await unsubscribed(), true, "opening the link lifts nothing");

    // A confirm that didn't come from that page's button keeps the unsubscribe.
    const plain = await confirm(link);
    assert.equal(plain.statusCode, 200);
    assert.match(plain.body, /You&#39;d unsubscribed from Offbooked emails, so you won&#39;t hear/);
    assert.equal(await unsubscribed(), true);
    assert.deepEqual(await state(riz), { hasEmail: true, pendingEmail: false });
    assert.equal((await confirm(link, { resubscribe: "1" })).statusCode, 200);
    assert.equal(await unsubscribed(), false, "the button on the page that said so turns updates back on");

    // Jo only has an address waiting for its link.
    assert.deepEqual(await state(jo), { hasEmail: false, pendingEmail: true });
    await notifyCastComplete(t.ctx, pid);
    const ready = t.mailer.sent.filter((m) => m.subject.endsWith("is ready to listen through")).map((m) => m.to);
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
