import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { parsePersonKey } from "../admin/people.ts";
import { makeTone } from "../render/ffmpeg.ts";
import { SEED_SCENE } from "../seed-scene.ts";
import { bearer, createTestApp, dbSkip, productionWithScript, signIn, type TestApp } from "../test/helpers.ts";
import { ADMIN_ROUTES } from "./admin.ts";

interface Line {
  id: string;
  kind: string;
  characterId: string | null;
}

test("person keys parse, and nothing else does", () => {
  assert.deepEqual(parsePersonKey("e:Riz@Example.test"), { kind: "email", email: "riz@example.test" });
  const id = randomUUID();
  assert.deepEqual(parsePersonKey(`a:${id}`), { kind: "actor", id });
  assert.deepEqual(parsePersonKey(`u:${id.toUpperCase()}`), { kind: "user", id });
  for (const bad of ["", "e:nobody", "a:123", "x:" + id, "u:" + id + "0"]) assert.throws(() => parsePersonKey(bad), /person key/);
});

describe("the admin area", { skip: dbSkip }, () => {
  let t: TestApp;
  let root: string;
  let alice: string;
  let bob: string;
  let hamletId: string;
  let macbethId: string;
  let hamletLines: Line[];
  let macbethLines: Line[];
  let riz: { actorId: string; token: string };
  let riz2: { actorId: string; token: string };
  let jo: { actorId: string; token: string };
  let wav: Buffer;
  const rizTakes: string[] = [];

  const get = (url: string, token?: string) => t.app.inject({ method: "GET", url, headers: token ? bearer(token) : {} });
  const send = (method: "POST" | "PATCH", url: string, token: string, payload: object = {}) => t.app.inject({ method, url, headers: bearer(token), payload });
  const put = (url: string, authorization: string, takeId = randomUUID()) =>
    t.app
      .inject({ method: "PUT", url, headers: { authorization, "content-type": "audio/wav", "x-take-id": takeId, "x-duration-ms": "700" }, payload: wav })
      .then((res) => {
        assert.equal(res.statusCode, 200, res.body);
        return takeId;
      });
  const actorTake = (who: { token: string }, lineId: string) => put(`/api/invite/lines/${lineId}/take`, `Invite ${who.token}`);
  const linesOf = (lines: Line[], characterId: string) => lines.filter((l) => l.kind === "dialogue" && l.characterId === characterId);

  async function join(productionId: string, owner: string, body: object) {
    const { joinUrl } = (await get(`/api/productions/${productionId}/join-link`, owner)).json();
    const res = await send("POST", `/api/join/${joinUrl.split("/join/")[1]}/claim`, owner, body);
    assert.equal(res.statusCode, 200, res.body);
    const token = res.json().inviteToken as string;
    const [row] = await t.ctx.sql<{ id: string }[]>`select id from actors where production_id = ${productionId} order by created_at desc limit 1`;
    return { actorId: row!.id, token };
  }

  before(async () => {
    t = await createTestApp({ env: { ADMIN_EMAILS: " Root@Example.test , other-admin@example.test" } });
    const dir = await mkdtemp(path.join(tmpdir(), "offbooked-admin-"));
    await makeTone(0.7, 440, path.join(dir, "take.wav"));
    wav = await readFile(path.join(dir, "take.wav"));
    await rm(dir, { recursive: true, force: true });

    root = await signIn(t, "root@example.test");
    alice = await signIn(t, "alice@example.test");
    bob = await signIn(t, "bob@example.test");
    const hamlet = await productionWithScript(t, alice, SEED_SCENE, "Hamlet");
    const macbeth = await productionWithScript(t, bob, SEED_SCENE, "Macbeth");
    hamletId = hamlet.id;
    macbethId = macbeth.id;
    hamletLines = hamlet.script.lines;
    macbethLines = macbeth.script.lines;
    const charOf = (script: { characters: { id: string; name: string }[] }, name: string) => script.characters.find((c) => c.name === name)!.id;

    // Riz plays HAMLET in both shows (the same verified email), Jo plays HORATIO in Hamlet, and
    // someone joins Hamlet only to listen.
    riz = await join(hamletId, alice, { firstName: "Riz", characterIds: [charOf(hamlet.script, "HAMLET")] });
    jo = await join(hamletId, alice, { firstName: "Jo", characterIds: [charOf(hamlet.script, "HORATIO")] });
    await join(hamletId, alice, { listen: true });
    riz2 = await join(macbethId, bob, { firstName: "Riz", characterIds: [charOf(macbeth.script, "HAMLET")] });
    await t.ctx.sql`update actors set email = 'Riz@Example.test', email_verified_at = now() where id in ${t.ctx.sql([riz.actorId, riz2.actorId])}`;

    const [a1, a2] = linesOf(hamletLines, charOf(hamlet.script, "HAMLET"));
    rizTakes.push(await actorTake(riz, a1!.id), await actorTake(riz, a1!.id), await actorTake(riz, a2!.id));
    await actorTake(jo, linesOf(hamletLines, charOf(hamlet.script, "HORATIO"))[0]!.id);
    const [m1, m2] = linesOf(macbethLines, charOf(macbeth.script, "HAMLET"));
    await actorTake(riz2, m1!.id);
    await put(`/api/lines/${m2!.id}/take`, `Bearer ${bob}`);
    // Riz's first take of a1 was deleted (by anyone: who deleted it isn't stored).
    await t.ctx.sql`update takes set deleted_at = now() where id = ${rizTakes[0]!}`;
  });
  after(() => t.close());

  test("/api/me says who is an admin, by ADMIN_EMAILS in any case", async () => {
    assert.equal((await get("/api/me", root)).json().user.admin, true);
    assert.equal((await get("/api/me", alice)).json().user.admin, false);
  });

  test("every admin route is refused to anyone who isn't an admin", async () => {
    assert.ok(ADMIN_ROUTES.size >= 5, [...ADMIN_ROUTES].join(", "));
    for (const route of ADMIN_ROUTES) {
      const [method, pattern] = route.split(" ") as ["GET" | "POST", string];
      const url = pattern.replace(":key", encodeURIComponent("e:riz@example.test"));
      for (const headers of [{}, bearer(alice), bearer(bob), { authorization: "Bearer not-a-session" }]) {
        const res = await t.app.inject({ method, url, headers });
        assert.equal(res.statusCode, 404, `${route} with ${JSON.stringify(headers)}`);
        assert.equal(res.json().error.code, "not_found");
      }
      assert.equal((await t.app.inject({ method, url, headers: bearer(root) })).statusCode, 200, route);
    }
  });

  test("an admin opens a production they aren't in, read only, and each view is audited once", async () => {
    assert.equal((await get(`/api/productions/${hamletId}`, bob)).statusCode, 404, "another director still can't");
    const opened = await get(`/api/productions/${hamletId}`, root);
    assert.equal(opened.statusCode, 200);
    assert.equal(opened.json().production.access, "admin");
    assert.equal(opened.json().production.title, "Hamlet");
    assert.equal((await get(`/api/productions/${hamletId}`, alice)).json().production.access, "owner");

    const sectionId = (await get(`/api/productions/${hamletId}/script`, root)).json().sections[0].id;
    const hamletChar = hamletLines.find((l) => l.kind === "dialogue")!.characterId!;
    for (const url of [
      `/api/productions/${hamletId}/script`,
      `/api/productions/${hamletId}/call-sheet`,
      `/api/productions/${hamletId}/runthrough`,
      `/api/productions/${hamletId}/sections/${sectionId}/lines`,
      `/api/productions/${hamletId}/characters/${hamletChar}/lines`,
    ]) {
      assert.equal((await get(url, root)).statusCode, 200, url);
      assert.equal((await get(url, bob)).statusCode, 404, url);
    }
    // Each cast member's invite link and the cast join link are credentials: never the admin's.
    for (const url of [`/api/productions/${hamletId}/cast`, `/api/productions/${hamletId}/join-link`]) {
      assert.equal((await get(url, root)).statusCode, 403, url);
      assert.equal((await get(url, alice)).statusCode, 200, url);
    }
    const studio = (await get(`/api/productions/${hamletId}/characters/${hamletChar}/lines`, root)).json();
    assert.ok(studio.lines.length > 0);

    for (const [method, url, payload] of [
      ["PATCH", `/api/productions/${hamletId}`, { title: "Renamed" }],
      ["POST", `/api/productions/${hamletId}/archive`, {}],
      ["POST", `/api/productions/${hamletId}/join-link/reset`, {}],
      ["POST", `/api/productions/${hamletId}/render`, {}],
      ["PATCH", `/api/lines/${hamletLines.find((l) => l.kind === "dialogue")!.id}`, { text: "Changed" }],
      ["PATCH", `/api/characters/${hamletChar}`, { name: "RENAMED" }],
      ["PATCH", `/api/sections/${sectionId}`, { title: "Renamed" }],
      ["PATCH", `/api/cast/${jo.actorId}`, { name: "Renamed" }],
      ["POST", `/api/takes/${rizTakes[0]!}/restore`, {}],
    ] as const) {
      const res = await send(method, url, root, payload);
      assert.equal(res.statusCode, 403, url);
      assert.equal(res.json().error.code, "admin_read_only");
      assert.equal((await send(method, url, bob, payload)).statusCode, 404, url);
    }
    assert.equal((await get(`/api/productions/${hamletId}`, alice)).json().production.title, "Hamlet", "nothing changed");

    const audit = (await get(`/api/admin/audit?productionId=${hamletId}`, root)).json().entries;
    assert.equal(audit.length, 1, "many requests in a few minutes are one view");
    assert.equal(audit[0].action, "view_production");
    assert.equal(audit[0].admin, "root@example.test");
    assert.deepEqual(audit[0].production, { id: hamletId, title: "Hamlet" });
    assert.equal((await get(`/api/admin/audit?productionId=${macbethId}`, root)).json().entries.length, 0, "only what was opened");
    // The owner looking at their own show is never audited.
    await get(`/api/productions/${macbethId}`, bob);
    assert.equal((await t.ctx.sql`select 1 from admin_audit where production_id = ${macbethId}`).length, 0);
  });

  test("every production, searchable by title or owner", async () => {
    const all = (await get("/api/admin/productions", root)).json().productions;
    assert.deepEqual(all.map((p: { title: string }) => p.title).sort(), ["Hamlet", "Macbeth"]);
    const hamlet = all.find((p: { id: string }) => p.id === hamletId);
    assert.equal(hamlet.owner.email, "alice@example.test");
    assert.equal(hamlet.owner.key, "e:alice@example.test");
    assert.equal(hamlet.linesTotal, hamletLines.filter((l) => l.kind === "dialogue").length);
    assert.equal(hamlet.linesRecorded, 3, "Riz's two lines and Jo's one");
    assert.equal(hamlet.takes, 3, "the deleted take doesn't count");
    assert.equal(hamlet.castMembers, 3, "the listener counts");
    const titles = async (q: string) =>
      (await get(`/api/admin/productions?q=${encodeURIComponent(q)}`, root)).json().productions.map((p: { title: string }) => p.title);
    assert.deepEqual(await titles("mac"), ["Macbeth"]);
    assert.deepEqual(await titles("ALICE@"), ["Hamlet"]);
    assert.deepEqual(await titles("%"), [], "wildcards are plain characters");
  });

  test("headline figures for each email that created a production", async () => {
    const creators = (await get("/api/admin/creators", root)).json().creators;
    assert.deepEqual(creators.map((c: { email: string }) => c.email).sort(), ["alice@example.test", "bob@example.test"], "root made nothing");
    const alice = creators.find((c: { email: string }) => c.email === "alice@example.test");
    assert.equal(alice.key, "e:alice@example.test");
    assert.equal(alice.productions, 1);
    assert.equal(alice.activeProductions, 1);
    assert.equal(alice.castMembers, 3);
    assert.equal(alice.linesRecorded, 3);
    assert.equal(alice.takes, 3);
    assert.equal(alice.plan.name, "Free beta");
    assert.ok(alice.lastSignInAt && alice.signedUpAt);
    // Public beta: no access code, so only accounts from the private beta have a betaAccessAt.
    assert.equal(alice.plan.betaAccessAt, null);
    const bob = creators.find((c: { email: string }) => c.email === "bob@example.test");
    assert.deepEqual([bob.productions, bob.castMembers, bob.linesRecorded, bob.takes], [1, 1, 2, 2], "Riz's take and Bob's own");
  });

  test("everyone who has recorded, one row per person across productions", async () => {
    const recorders = (await get("/api/admin/recorders", root)).json().recorders;
    assert.equal(recorders.length, 3, JSON.stringify(recorders.map((r: { key: string }) => r.key)));
    const byKey = new Map(recorders.map((r: { key: string }) => [r.key, r]));
    const rizRow = byKey.get("e:riz@example.test") as Record<string, unknown>;
    assert.equal(rizRow.name, "Riz");
    assert.equal(rizRow.email, "Riz@Example.test");
    assert.equal(rizRow.kind, "cast");
    assert.equal(rizRow.takes, 3);
    assert.equal(rizRow.linesRecorded, 3);
    assert.deepEqual(
      (rizRow.productions as { title: string; role: string }[]).map((p) => `${p.title}:${p.role}`),
      ["Hamlet:cast", "Macbeth:cast"],
    );
    assert.ok(Date.parse(rizRow.lastSeenAt as string) >= Date.parse(rizRow.lastRecordingAt as string));
    assert.ok(Date.parse(rizRow.firstRecordingAt as string) <= Date.parse(rizRow.lastRecordingAt as string));
    const joRow = byKey.get(`a:${jo.actorId}`) as Record<string, unknown>;
    assert.deepEqual([joRow.name, joRow.email, joRow.takes, joRow.linesRecorded], ["Jo", null, 1, 1]);
    const bobRow = byKey.get("e:bob@example.test") as Record<string, unknown>;
    assert.deepEqual([bobRow.kind, bobRow.takes, bobRow.email], ["director", 1, "bob@example.test"]);
    assert.deepEqual(bobRow.productions, [{ id: macbethId, title: "Macbeth", role: "owner" }]);
  });

  test("a person's trace is their story in order, and looking is audited", async () => {
    const res = await get(`/api/admin/people/${encodeURIComponent("e:riz@example.test")}`, root);
    assert.equal(res.statusCode, 200, res.body);
    const person = res.json().person;
    assert.equal(person.name, "Riz");
    assert.deepEqual(person.emails, ["riz@example.test"]);
    assert.equal(person.castRows.length, 2);
    const ats = person.events.map((e: { at: string }) => Date.parse(e.at));
    assert.deepEqual(
      ats,
      [...ats].sort((a, b) => a - b),
      "oldest first",
    );
    const texts = person.events.map((e: { kind: string; text: string; production: { title: string } | null }) => `${e.kind} ${e.production?.title}: ${e.text}`);
    for (const expected of [
      "joined_cast Hamlet: Joined the cast",
      "joined_cast Macbeth: Joined the cast",
      "recorded Hamlet: Recorded 3 takes of 2 lines",
      "recorded Macbeth: Recorded 1 take of 1 line",
      "takes_deleted Hamlet: 1 take deleted",
      "email_verified Hamlet: Verified their email",
    ])
      assert.ok(texts.includes(expected), `${expected} in ${texts.join(" | ")}`);
    assert.ok(!texts.some((s: string) => s.startsWith("signed_up")), "a cast member has no account");

    const bobTrace = (await get(`/api/admin/people/${encodeURIComponent("e:bob@example.test")}`, root)).json().person;
    const kinds = bobTrace.events.map((e: { kind: string }) => e.kind);
    for (const kind of ["signed_up", "signed_in", "production_created", "script_uploaded", "script_read", "recorded"])
      assert.ok(kinds.includes(kind), `${kind} in ${kinds.join(", ")}`);
    assert.ok(kinds.indexOf("signed_up") < kinds.indexOf("production_created"));

    const joTrace = (await get(`/api/admin/people/a:${jo.actorId}`, root)).json().person;
    assert.deepEqual(
      joTrace.castRows.map((r: { name: string }) => r.name),
      ["Jo"],
    );
    assert.equal((await get(`/api/admin/people/a:${riz.actorId}`, root)).statusCode, 404, "a cast row with a verified email is traced by its email");
    assert.equal((await get(`/api/admin/people/${encodeURIComponent("e:nobody@example.test")}`, root)).statusCode, 404);
    assert.equal((await get(`/api/admin/people/nonsense`, root)).statusCode, 400);

    const views = (await get("/api/admin/audit", root)).json().entries.filter((e: { action: string }) => e.action === "view_person");
    assert.ok(views.some((e: { subject: string }) => e.subject === "e:riz@example.test"));
    await get(`/api/admin/people/${encodeURIComponent("e:RIZ@example.test")}`, root);
    assert.equal((await t.ctx.sql`select 1 from admin_audit where subject ilike 'e:riz@%'`).length, 1, "one spelling of a person");
  });

  test("deleting an account takes its email out of the audit log", async () => {
    const carol = await signIn(t, "carol@example.test");
    await productionWithScript(t, carol, SEED_SCENE, "Carol's show");
    const [user] = await t.ctx.sql<{ id: string }[]>`select id from users where email = 'carol@example.test'`;
    assert.equal((await get(`/api/admin/people/${encodeURIComponent("e:carol@example.test")}`, root)).statusCode, 200);
    const del = await t.app.inject({ method: "DELETE", url: "/api/me", headers: bearer(carol), payload: { confirm: true } });
    assert.equal(del.statusCode, 204);
    const subjects = (await get("/api/admin/audit", root)).json().entries.map((e: { subject: string | null }) => e.subject);
    assert.ok(!subjects.some((s: string | null) => s?.includes("carol")), subjects.join(", "));
    assert.ok(subjects.includes(`u:${user!.id}`));
    // The account still shows as a creator, without its email, and its trace is under its id.
    const creator = (await get("/api/admin/creators", root)).json().creators.find((c: { key: string }) => c.key === `u:${user!.id}`);
    assert.equal(creator.email, null);
    assert.ok(creator.deletedAt);
    const trace = (await get(`/api/admin/people/u:${user!.id}`, root)).json().person;
    assert.ok(trace.events.some((e: { kind: string }) => e.kind === "account_deleted"));
  });
});
