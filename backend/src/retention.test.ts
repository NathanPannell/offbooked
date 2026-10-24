import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { after, before, describe, test } from "node:test";
import type { Ctx } from "./context.ts";
import { scheduleRender, processDueRenders } from "./render/queue.ts";
import { startScriptParse } from "./parse/job.ts";
import {
  ContentDeletedError,
  deleteAccount,
  deleteProductionContent,
  dueContent,
  RETENTION_DAYS,
  startRetentionWorker,
  sweepIfDeleted,
  type RetentionWorker,
} from "./retention.ts";
import { notifyActorsDone, notifyCastComplete } from "./email/notify.ts";
import { performanceDates } from "./routes/productions.ts";
import { SEED_SCENE } from "./seed-scene.ts";
import type { LocalStorage } from "./storage/local.ts";
import { bearer, createTestApp, dbSkip, invite, productionWithScript, signIn, type TestApp } from "./test/helpers.ts";
import { FakeSynthesizer, toneWav } from "./test/tts.ts";

const DAY_MS = 86_400_000;
// Short, so the render and TTS in the deletion test stay quick on CI.
const SCENE = "HAMLET: Hail to your lordship.\nHORATIO: The same, my lord.\nHAMLET: Sir, my good friend.\nHORATIO: A truant disposition.\n";
const day = (offsetDays: number, from = Date.now()) => new Date(from + offsetDays * DAY_MS).toISOString().slice(0, 10);
const deletionMoment = (endsOn: string) => Date.parse(`${endsOn}T12:00:00Z`) + RETENTION_DAYS * DAY_MS;

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("timed out");
    await delay(20);
  }
}

// A ctx whose sql counts every query sent, so an idle worker can be shown to send none.
function counting(ctx: Ctx): { ctx: Ctx; queries: () => number } {
  let n = 0;
  const sql = new Proxy(ctx.sql, {
    apply(target, self, args) {
      n++;
      return Reflect.apply(target, self, args);
    },
  });
  return { ctx: { ...ctx, sql }, queries: () => n };
}

const exists = (file: string) =>
  access(file).then(
    () => true,
    () => false,
  );

describe("performance dates (validation)", () => {
  const now = Date.parse("2026-10-20T09:00:00Z");

  test("a new production always gets a final date", () => {
    assert.deepEqual(performanceDates({}, undefined, now), { startsOn: null, endsOn: "2027-10-20" });
    assert.deepEqual(performanceDates({ performanceStartsOn: "2026-11-05" }, undefined, now), { startsOn: "2026-11-05", endsOn: "2026-11-05" });
    assert.deepEqual(performanceDates({ performanceStartsOn: "2026-11-05", performanceEndsOn: "2026-11-08" }, undefined, now), {
      startsOn: "2026-11-05",
      endsOn: "2026-11-08",
    });
  });

  test("refuses dates that aren't real, starts after the end, and ends whose content is already due", () => {
    for (const bad of ["2026-02-30", "2026-13-01", "20261101", "next week", "2026-11-1"])
      assert.throws(() => performanceDates({ performanceEndsOn: bad }, undefined, now), /must be a date/, bad);
    assert.throws(() => performanceDates({ performanceStartsOn: "2026-11-09", performanceEndsOn: "2026-11-08" }, undefined, now), /on or before/);
    // Six days ago is the earliest: its content goes at 12:00 UTC tomorrow. Seven days ago would go
    // at 12:00 today, three hours after a slip in the date picker, so it is refused.
    assert.equal(performanceDates({ performanceEndsOn: "2026-10-14" }, undefined, now).endsOn, "2026-10-14");
    assert.throws(() => performanceDates({ performanceEndsOn: "2026-10-13" }, undefined, now), /more than 6 days ago/);
    assert.throws(() => performanceDates({ performanceEndsOn: "2026-10-13" }, undefined, Date.parse("2026-10-20T00:00:01Z")), /more than 6 days ago/);
    assert.throws(() => performanceDates({ performanceStartsOn: "2026-09-01" }, undefined, now), /more than 6 days ago/, "a start alone is the final date");
  });

  test("an update keeps what it doesn't change and checks against what's there", () => {
    const current = { startsOn: "2026-11-05", endsOn: "2026-11-08" };
    assert.deepEqual(performanceDates({}, current, now), current);
    assert.deepEqual(performanceDates({ performanceStartsOn: null }, current, now), { startsOn: null, endsOn: "2026-11-08" });
    assert.throws(() => performanceDates({ performanceEndsOn: null }, current, now), /needs a final performance date/);
    assert.throws(() => performanceDates({ performanceStartsOn: "2026-11-09" }, current, now), /on or before/);
    assert.throws(() => performanceDates({ performanceEndsOn: "2026-11-04" }, current, now), /on or before/);
    // An unchanged final date that is already past isn't re-checked (the worker deletes it).
    const past = { startsOn: null, endsOn: "2026-01-01" };
    assert.deepEqual(performanceDates({ performanceStartsOn: "2025-12-31" }, past, now), { startsOn: "2025-12-31", endsOn: "2026-01-01" });
    // Once the content is due, the final date is fixed, so a pass already deleting it can't race a move.
    assert.throws(() => performanceDates({ performanceEndsOn: "2026-12-01" }, past, now), /due for deletion/);
    assert.deepEqual(performanceDates({ performanceEndsOn: "2026-01-01" }, past, now), past, "sending the same date is fine");
  });
});

describe("content retention", { skip: dbSkip }, () => {
  let t: TestApp;
  let director: string;
  const get = (url: string, token = director) => t.app.inject({ method: "GET", url, headers: bearer(token) });
  const send = (method: "POST" | "PATCH", url: string, payload: object, token = director) => t.app.inject({ method, url, headers: bearer(token), payload });

  before(async () => {
    t = await createTestApp({ synthesizer: new FakeSynthesizer(), env: { TTS_CUE_WAIT_MS: "0" } });
    director = await signIn(t, "director@example.test");
  });
  after(() => t.close());

  test("productions carry performance dates and the day their content is deleted", async () => {
    const created = await send("POST", "/api/productions", { title: "Twelfth Night", performanceStartsOn: day(30), performanceEndsOn: day(33) });
    assert.equal(created.statusCode, 200);
    const p = created.json().production;
    assert.equal(p.performanceStartsOn, day(30));
    assert.equal(p.performanceEndsOn, day(33));
    assert.equal(p.contentDeletesOn, day(33 + RETENTION_DAYS));
    assert.equal(p.performanceDate, undefined, "the old single date is gone");

    const moved = (await send("PATCH", `/api/productions/${p.id}`, { performanceEndsOn: day(40) })).json().production;
    assert.deepEqual([moved.performanceStartsOn, moved.performanceEndsOn, moved.contentDeletesOn], [day(30), day(40), day(47)]);

    const bad = async (payload: object) => {
      const res = await send("PATCH", `/api/productions/${p.id}`, payload);
      assert.equal(res.statusCode, 400, JSON.stringify(payload));
      assert.equal(res.json().error.code, "bad_request");
    };
    await bad({ performanceEndsOn: "2027-02-30" });
    await bad({ performanceEndsOn: null });
    await bad({ performanceStartsOn: day(41) });
    await bad({ performanceEndsOn: day(-30) });
    assert.equal((await send("POST", "/api/productions", { title: "Typo", performanceEndsOn: day(-365) })).statusCode, 400);

    const plain = (await send("POST", "/api/productions", { title: "No dates yet" })).json().production;
    const inAYear = new Date();
    inAYear.setUTCFullYear(inAYear.getUTCFullYear() + 1);
    assert.equal(plain.performanceStartsOn, null);
    assert.equal(plain.performanceEndsOn, inAYear.toISOString().slice(0, 10));

    // The update itself checks the database: a production whose content is gone keeps its dates.
    await t.ctx.sql`update productions set content_deleted_at = now() where id = ${plain.id}`;
    const late = await send("PATCH", `/api/productions/${plain.id}`, { performanceEndsOn: day(20) });
    assert.equal(late.statusCode, 409);
    assert.equal(late.json().error.code, "content_due");
    assert.equal((await send("PATCH", `/api/productions/${plain.id}`, { title: "Renamed" })).statusCode, 200, "other fields can still change");
  });

  test("the migration backfills a final date of 2027-10-20 and keeps the old date as the opening", async () => {
    const [owner] = await t.ctx.sql<{ id: string }[]>`select id from users limit 1`;
    const [legacy] = await t.ctx.sql<{ id: string }[]>`
      insert into productions (owner_id, title, performance_date) values (${owner!.id}, 'Legacy', '2026-12-01') returning id`;
    const [undated] = await t.ctx.sql<{ id: string }[]>`
      insert into productions (owner_id, title) values (${owner!.id}, 'Legacy, no date') returning id`;
    const [dated] = await t.ctx.sql<{ id: string }[]>`
      insert into productions (owner_id, title, performance_starts_on, performance_ends_on) values (${owner!.id}, 'Dated', '2026-11-01', '2026-11-03') returning id`;
    const [later] = await t.ctx.sql<{ id: string }[]>`
      insert into productions (owner_id, title, performance_date) values (${owner!.id}, 'Opens late', '2028-03-01') returning id`;
    // Re-running the migration's statements is what CI's second migrate run proves is safe.
    await t.ctx.sql.unsafe(await readFile(new URL("../migrations/013_performance_dates.sql", import.meta.url), "utf8"));
    const rows = await t.ctx.sql<{ id: string; startsOn: string | null; endsOn: string }[]>`
      select id, performance_starts_on::text as starts_on, performance_ends_on::text as ends_on from productions
      where id = any(${[legacy!.id, undated!.id, dated!.id, later!.id]}::uuid[])`;
    const byId = new Map(rows.map((r) => [r.id, [r.startsOn, r.endsOn]]));
    assert.deepEqual(byId.get(legacy!.id), ["2026-12-01", "2027-10-20"]);
    assert.deepEqual(byId.get(undated!.id), [null, "2027-10-20"]);
    assert.deepEqual(byId.get(dated!.id), ["2026-11-01", "2026-11-03"], "existing dates are left alone");
    assert.deepEqual(byId.get(later!.id), ["2028-03-01", "2028-03-01"], "a show opening after the backfill date keeps its content until it has played");
    await assert.rejects(
      t.ctx.sql`update productions set performance_starts_on = '2028-01-01' where id = ${dated!.id}`,
      /productions_performance_order/,
      "the database refuses a start after the end",
    );
    await t.ctx.sql`delete from productions where id = any(${[legacy!.id, undated!.id, dated!.id, later!.id]}::uuid[])`;
  });

  test("deletes a production's script, recordings and renders for good, keeps shared TTS and a tombstone", { timeout: 120_000 }, async () => {
    const root = (t.ctx.storage as LocalStorage).root;
    const show = async (title: string) => {
      const { id, script } = await productionWithScript(t, director, SCENE, title);
      const { joinUrl } = (await get(`/api/productions/${id}/join-link`)).json();
      const joinToken = joinUrl.split("/join/")[1] as string;
      const hamlet = script.characters.find((c: { name: string }) => c.name === "HAMLET");
      const claim = (await send("POST", `/api/join/${joinToken}/claim`, { firstName: "Riz", characterIds: [hamlet.id] })).json();
      const inviteHeaders = invite(`https://app.test/i/${claim.inviteToken}`);
      const [line, other] = script.lines.filter((l: { kind: string; characterId: string }) => l.kind === "dialogue" && l.characterId === hamlet.id);
      const otherLine = script.lines.find((l: { kind: string; characterId: string }) => l.kind === "dialogue" && l.characterId !== hamlet.id);
      const wav = toneWav(0.7, 440);
      const put = (url: string, headers: Record<string, string>) =>
        t.app.inject({
          method: "PUT",
          url,
          headers: { ...headers, "content-type": "audio/wav", "x-take-id": randomUUID(), "x-duration-ms": "700" },
          payload: wav,
        });
      assert.equal((await put(`/api/invite/lines/${line.id}/take`, inviteHeaders)).statusCode, 200);
      assert.equal((await put(`/api/invite/lines/${other.id}/take`, inviteHeaders)).statusCode, 200);
      assert.equal((await put(`/api/lines/${otherLine.id}/take`, bearer(director))).statusCode, 200, "a stand-in take");
      // Line-by-line audio normalizes a take (FLAC + stream m4a) and makes a TTS clip for an unrecorded line.
      assert.equal((await get(`/api/productions/${id}/lines/${line.id}/audio`)).statusCode, 200);
      await scheduleRender(t.ctx, id, { force: true });
      await processDueRenders(t.ctx);
      await t.ctx.jobs.idle();
      return { id, joinToken, inviteHeaders };
    };
    const doomed = await show("Doomed");
    const kept = await show("Kept");

    const count = async (table: string, id: string) =>
      (await t.ctx.sql<{ n: number }[]>`select count(*)::int as n from ${t.ctx.sql(table)} where production_id = ${id}`)[0]!.n;
    for (const table of ["sections", "characters", "lines", "takes", "renders", "scripts"]) assert.ok((await count(table, doomed.id)) > 0, table);
    assert.equal((await t.ctx.sql`select 1 from renders where production_id = ${doomed.id} and status = 'ready'`).length, 1, "a render was made");
    const folder = path.join(root, "productions", doomed.id);
    const before = await readdir(folder, { recursive: true });
    for (const kind of ["takes", "normalized", "scripts", "renders"])
      assert.ok(
        before.some((f) => f.startsWith(kind)),
        `${kind} stored`,
      );
    // Both shows have the same lines: synthesized speech is shared by hash, and each records what it uses.
    const usesOf = async (id: string) => (await t.ctx.sql<{ hash: string }[]>`select hash from tts_clip_uses where production_id = ${id}`).map((r) => r.hash);
    const keptClips = await usesOf(kept.id);
    const doomedOnly = (await usesOf(doomed.id)).filter((h) => !keptClips.includes(h));
    assert.ok(keptClips.length > 0 && (await usesOf(doomed.id)).length > 0, "both shows recorded the clips they use");

    // Something written while the rows go (an in-flight upload) is caught by the second sweep.
    const storage = t.ctx.storage;
    let sweeps = 0;
    const ctx: Ctx = {
      ...t.ctx,
      storage: Object.assign(Object.create(Object.getPrototypeOf(storage)), storage, {
        deletePrefix: async (prefix: string) => {
          const n = await storage.deletePrefix(prefix);
          if (++sweeps === 1) await storage.put(`${prefix}takes/late.wav`, Buffer.from("x"), "audio/wav");
          return n;
        },
      }),
    };
    // A cast member who verified an email (to hear when the play is ready) keeps their details; Riz
    // left none, and Ana typed one but never opened its link, so it doesn't count. Mo's new address,
    // still waiting for its link, goes.
    await t.ctx.sql`
      insert into actors (production_id, name, first_name, email, email_verified_at, pending_email, phone)
      values (${doomed.id}, 'Mo Lee', 'Mo', 'mo@example.test', now(), 'mo.new@example.test', '555')`;
    await t.ctx.sql`
      insert into actors (production_id, name, first_name, pending_email, pending_email_sent_at, phone)
      values (${doomed.id}, 'Ana Ruiz', 'Ana', 'ana@example.test', now(), '556')`;
    assert.equal(await deleteProductionContent(ctx, doomed.id), null, "not due yet: nothing is touched");
    assert.equal(sweeps, 0);
    assert.equal(await count("lines", doomed.id), await count("lines", kept.id));
    await t.ctx.sql`update productions set performance_ends_on = ${day(-8)} where id = ${doomed.id}`;
    const result = await deleteProductionContent(ctx, doomed.id);
    assert.equal(sweeps, 2);
    assert.ok(result && result.objects > before.filter((f) => f.includes(".")).length, "the late file counts too");

    for (const table of ["sections", "characters", "lines", "takes", "renders", "scripts", "take_mixes", "practice_runs"])
      assert.equal(await count(table, doomed.id), 0, `${table} deleted`);
    assert.equal(await exists(folder), false, "the production's storage folder is gone");
    const [tomb] = await t.ctx.sql<{ title: string; archivedAt: Date | null; contentDeletedAt: Date | null; scriptStatus: string }[]>`
      select title, archived_at, content_deleted_at, script_status from productions where id = ${doomed.id}`;
    assert.equal(tomb!.title, "Doomed");
    assert.ok(tomb!.archivedAt && tomb!.contentDeletedAt);
    assert.equal(tomb!.scriptStatus, "none");
    assert.equal(await count("actors", doomed.id), 3, "actors stay so their links say the show has wrapped");
    const cast = await t.ctx.sql<{ name: string; firstName: string | null; email: string | null; pendingEmail: string | null; phone: string | null }[]>`
      select name, first_name, email, pending_email, phone from actors where production_id = ${doomed.id} order by created_at, id`;
    const cleared = { name: "", firstName: null, email: null, pendingEmail: null, phone: null };
    assert.deepEqual(cast[0], cleared, "details not tied to an email are cleared");
    assert.deepEqual(
      cast[1],
      { name: "Mo Lee", firstName: "Mo", email: "mo@example.test", pendingEmail: null, phone: "555" },
      "details tied to a verified email are kept",
    );
    assert.deepEqual(cast[2], cleared, "an address never verified doesn't keep anything");
    const keptCast = await t.ctx.sql<{ firstName: string | null }[]>`select first_name from actors where production_id = ${kept.id}`;
    assert.deepEqual(
      keptCast.map((a) => a.firstName),
      ["Riz"],
      "the other production's cast is untouched",
    );

    // Its synthesized speech goes, files and rows, except what the other show uses; that show is untouched.
    const clipsLeft = async (hashes: string[]) =>
      (await t.ctx.sql<{ hash: string }[]>`select hash from tts_clips where hash = any(${hashes}::text[])`).map((r) => r.hash);
    assert.deepEqual(await clipsLeft(doomedOnly), [], "clips only the deleted show used are gone");
    for (const h of doomedOnly) assert.equal(await exists(path.join(root, "tts", `${h}.flac`)), false);
    assert.deepEqual((await clipsLeft(keptClips)).sort(), [...keptClips].sort(), "the other show's clips stay");
    for (const h of keptClips) assert.ok(await exists(path.join(root, "tts", `${h}.flac`)));
    assert.deepEqual(await usesOf(doomed.id), []);
    for (const table of ["sections", "characters", "lines", "takes", "renders", "scripts"]) assert.ok((await count(table, kept.id)) > 0, `kept ${table}`);
    assert.ok(await exists(path.join(root, "productions", kept.id)));

    // Cast and join links show "This show has wrapped"; the director's list hides it and it can't be refilled.
    const inviteRes = await t.app.inject({ method: "GET", url: "/api/invite", headers: doomed.inviteHeaders });
    assert.equal(inviteRes.statusCode, 410);
    assert.equal(inviteRes.json().productionTitle, "Doomed");
    assert.equal((await t.app.inject({ method: "GET", url: `/api/join/${doomed.joinToken}` })).statusCode, 410);
    assert.ok(!(await get("/api/productions")).json().productions.some((p: { id: string }) => p.id === doomed.id));
    assert.equal((await send("POST", `/api/productions/${doomed.id}/script`, { text: SEED_SCENE })).statusCode, 410);
    assert.equal((await t.app.inject({ method: "GET", url: "/api/invite", headers: kept.inviteHeaders })).statusCode, 200);

    // Safe to run again: nothing left to do.
    assert.equal(await deleteProductionContent(t.ctx, doomed.id), null);
    assert.equal(await t.ctx.storage.deletePrefix(`productions/${doomed.id}/`), 0);

    // A writer that finishes after the last sweep (a slow upload, render or parse) sweeps up after itself.
    assert.equal(await sweepIfDeleted(t.ctx, kept.id), false, "a live production is left alone");
    await t.ctx.storage.put(`productions/${doomed.id}/renders/late.m4a`, Buffer.from("x"), "audio/mp4");
    assert.equal(await sweepIfDeleted(t.ctx, doomed.id), true);
    assert.equal(await exists(folder), false);
    await assert.rejects(startScriptParse(t.ctx, doomed.id, { kind: "text", text: SCENE }), ContentDeletedError);
    assert.equal(await count("scripts", doomed.id), 0);
    assert.equal(await exists(folder), false);
  });

  test("a failed storage delete leaves the production for the next pass", async () => {
    const { id } = await productionWithScript(t, director, SEED_SCENE, "Flaky");
    await t.ctx.sql`update productions set performance_ends_on = ${day(-8)} where id = ${id}`;
    const ctx: Ctx = {
      ...t.ctx,
      storage: Object.assign(Object.create(Object.getPrototypeOf(t.ctx.storage)), t.ctx.storage, {
        deletePrefix: async () => {
          throw new Error("bucket unavailable");
        },
      }),
    };
    await assert.rejects(deleteProductionContent(ctx, id), /bucket unavailable/);
    const [row] = await t.ctx.sql<{ contentDeletedAt: Date | null; lines: number }[]>`
      select content_deleted_at, (select count(*)::int from lines where production_id = ${id}) as lines from productions where id = ${id}`;
    assert.equal(row!.contentDeletedAt, null);
    assert.ok(row!.lines > 0, "rows are only deleted after the storage objects");
    assert.ok((await deleteProductionContent(t.ctx, id))?.objects, "a later pass finishes the job");
  });

  test("deleting an account deletes its productions, recordings and cast details now, and only its own", { timeout: 60_000 }, async () => {
    const root = (t.ctx.storage as LocalStorage).root;
    const leaving = await signIn(t, "leaving@example.test");
    await send("PATCH", "/api/me", { name: "Lee" }, leaving);
    const { id, script } = await productionWithScript(t, leaving, SCENE, "Leaving show");
    const other = await productionWithScript(t, director, SCENE, "Someone else's show");
    const { joinUrl } = (await get(`/api/productions/${id}/join-link`, leaving)).json();
    const hamlet = script.characters.find((c: { name: string }) => c.name === "HAMLET");
    const claim = (await send("POST", `/api/join/${joinUrl.split("/join/")[1]}/claim`, { firstName: "Riz", characterIds: [hamlet.id] }, leaving)).json();
    const inviteHeaders = invite(`https://app.test/i/${claim.inviteToken}`);
    const line = script.lines.find((l: { kind: string; characterId: string }) => l.kind === "dialogue" && l.characterId === hamlet.id);
    const take = await t.app.inject({
      method: "PUT",
      url: `/api/invite/lines/${line.id}/take`,
      headers: { ...inviteHeaders, "content-type": "audio/wav", "x-take-id": randomUUID(), "x-duration-ms": "700" },
      payload: toneWav(0.7, 440),
    });
    assert.equal(take.statusCode, 200);
    // Even a cast member who verified an email loses their details: the show is gone, not wrapped.
    await t.ctx.sql`update actors set email = 'riz@example.test', email_verified_at = now(), phone = '555' where production_id = ${id}`;
    await t.ctx.jobs.idle();
    assert.ok(await exists(path.join(root, "productions", id)));

    const unconfirmed = await t.app.inject({ method: "DELETE", url: "/api/me", headers: bearer(leaving), payload: {} });
    assert.equal(unconfirmed.statusCode, 400);
    assert.equal((await get("/api/me", leaving)).statusCode, 200, "nothing happens without confirm");

    const deleted = await t.app.inject({ method: "DELETE", url: "/api/me", headers: bearer(leaving), payload: { confirm: true } });
    assert.equal(deleted.statusCode, 204);
    assert.equal((await get("/api/me", leaving)).statusCode, 401, "signed out everywhere");

    const count = async (table: string, productionId: string) =>
      (await t.ctx.sql<{ n: number }[]>`select count(*)::int as n from ${t.ctx.sql(table)} where production_id = ${productionId}`)[0]!.n;
    for (const table of ["sections", "characters", "lines", "takes", "renders", "scripts"]) assert.equal(await count(table, id), 0, `${table} deleted`);
    for (const table of ["sections", "characters", "lines", "scripts"]) assert.ok((await count(table, other.id)) > 0, `other ${table} kept`);
    assert.equal(await exists(path.join(root, "productions", id)), false, "storage folder gone");
    assert.ok(await exists(path.join(root, "productions", other.id)), "the other director's folder stays");
    const [tomb] = await t.ctx.sql<{ title: string; contentDeletedAt: Date | null }[]>`select title, content_deleted_at from productions where id = ${id}`;
    assert.equal(tomb!.title, "");
    assert.ok(tomb!.contentDeletedAt);
    const cast = await t.ctx.sql<{ name: string; email: string | null; phone: string | null; directorUserId: string | null }[]>`
      select name, email, phone, director_user_id from actors where production_id = ${id}`;
    assert.ok(cast.length > 0);
    for (const a of cast) assert.deepEqual(a, { name: "", email: null, phone: null, directorUserId: null });
    // The cast's links say the show was taken down, naming neither the show nor a "Deleted" director.
    for (const res of [
      await t.app.inject({ method: "GET", url: "/api/invite", headers: inviteHeaders }),
      await t.app.inject({ method: "GET", url: `/api/join/${joinUrl.split("/join/")[1]}` }),
    ]) {
      assert.equal(res.statusCode, 410);
      const body = res.json();
      assert.equal(body.error.code, "production_deleted");
      assert.equal(body.directorName, undefined);
      assert.equal(body.productionTitle, undefined);
      assert.doesNotMatch(res.body, /Deleted|deleted\.invalid/);
    }

    const users = await t.ctx.sql<{ email: string; name: string | null; deletedAt: Date | null }[]>`
      select email, name, deleted_at from users where email = 'leaving@example.test' or email like 'deleted-%'`;
    assert.equal(users.length, 1);
    assert.match(users[0]!.email, /^deleted-[0-9a-f-]+@deleted\.invalid$/);
    assert.equal(users[0]!.name, null);
    assert.ok(users[0]!.deletedAt);
    assert.equal((await t.ctx.sql`select 1 from login_tokens where email = 'leaving@example.test'`).length, 0);

    // The same address can sign up again, into a new, empty account.
    const again = await signIn(t, "leaving@example.test");
    assert.deepEqual((await get("/api/productions", again)).json().productions, []);
    assert.equal((await get(`/api/productions/${other.id}`)).statusCode, 200);
  });

  test("an account deleted while storage is down is gone at once; retention deletes its content later", async () => {
    const leaving = await signIn(t, "flaky-leaver@example.test");
    const [{ id: userId }] = await t.ctx.sql<{ id: string }[]>`select id from users where email = 'flaky-leaver@example.test'`;
    const { id } = await productionWithScript(t, leaving, SEED_SCENE, "Flaky leaver");
    let kicks = 0;
    const ctx: Ctx = {
      ...t.ctx,
      retention: { kick: () => void kicks++, touch() {} },
      storage: Object.assign(Object.create(Object.getPrototypeOf(t.ctx.storage)), t.ctx.storage, {
        deletePrefix: async () => {
          throw new Error("bucket unavailable");
        },
      }),
    };
    await deleteAccount(ctx, userId!);
    assert.equal(kicks, 1, "the retention worker is told");
    assert.equal((await get("/api/me", leaving)).statusCode, 401, "signed out even though storage failed");
    const [row] = await t.ctx.sql<{ title: string; contentDeletedAt: Date | null }[]>`select title, content_deleted_at from productions where id = ${id}`;
    assert.equal(row!.title, "", "who and what it was goes at once");
    assert.equal(row!.contentDeletedAt, null, "the content waits for storage");
    assert.ok((await dueContent(t.ctx.sql)).dueIds.includes(id), "and is due now");
    assert.ok((await deleteProductionContent(t.ctx, id))?.objects, "the next pass deletes it");
    assert.ok(!(await dueContent(t.ctx.sql)).dueIds.includes(id));
  });

  test("a deleted show's lines don't survive as synthesized speech, old or new; another show's do", { timeout: 60_000 }, async () => {
    const root = (t.ctx.storage as LocalStorage).root;
    const TEMPEST = "PROSPERO: Our revels now are ended.\nARIEL: Was it well done?\nPROSPERO: Bravely, my diligence.\n";
    const leaving = await signIn(t, "tempest@example.test");
    const [{ id: userId }] = await t.ctx.sql<{ id: string }[]>`select id from users where email = 'tempest@example.test'`;
    const { id, script } = await productionWithScript(t, leaving, TEMPEST, "The Tempest");
    const other = await productionWithScript(t, director, TEMPEST, "Another Tempest");
    for (const l of script.lines.filter((x: { kind: string }) => x.kind === "dialogue"))
      assert.equal((await get(`/api/productions/${id}/lines/${l.id}/audio`, leaving)).statusCode, 200);
    const own = (await t.ctx.sql<{ hash: string }[]>`select hash from tts_clip_uses where production_id = ${id}`).map((r) => r.hash);
    assert.ok(own.length >= 2, "playing its lines synthesized them and recorded the use");

    const clip = async (hash: string, timings: object[] | null, useBy?: string) => {
      await t.ctx.storage.put(`tts/${hash}.flac`, Buffer.from("x"), "audio/flac");
      await t.ctx.sql`insert into tts_clips (hash, voice, storage_key, samples, timings)
                      values (${hash}, 'x', ${`tts/${hash}.flac`}, 100, ${timings ? t.ctx.sql.json(timings as never) : null})`;
      if (useBy) await t.ctx.sql`insert into tts_clip_uses (hash, production_id) values (${hash}, ${useBy})`;
    };
    const said = (text: string) => [{ startMs: 0, endMs: 900, text, narrator: false }];
    await clip("old-settings-clip", said("Our revels now are ended."));
    await clip("before-timings-clip", null);
    await clip("other-shows-clip", said("Our revels now are ended."), other.id);

    await deleteAccount(t.ctx, userId!);

    const left = (
      await t.ctx.sql<{ hash: string }[]>`select hash from tts_clips where hash = any(${[...own, "old-settings-clip", "before-timings-clip"]}::text[])`
    ).map((r) => r.hash);
    assert.deepEqual(left, [], "its current clips, an older clip of its lines and a clip from before clips kept text all go");
    for (const h of [...own, "old-settings-clip", "before-timings-clip"]) assert.equal(await exists(path.join(root, "tts", `${h}.flac`)), false, h);
    const withItsWords = await t.ctx.sql<{ hash: string }[]>`select hash from tts_clips where timings::text like '%revels%'`;
    assert.deepEqual(
      withItsWords.map((r) => r.hash).filter((h) => !own.includes(h)),
      ["other-shows-clip"],
      "only the other show's own clip still says its words",
    );
    assert.ok(await exists(path.join(root, "tts", "other-shows-clip.flac")));

    // A synthesis for it that was already running when it went is deleted as soon as it lands.
    await clip("late-clip", said("Bravely, my diligence."));
    await t.ctx.tts!.cached(["late-clip"], id);
    assert.equal((await t.ctx.sql`select 1 from tts_clips where hash = 'late-clip'`).length, 0);
    assert.equal(await exists(path.join(root, "tts", "late-clip.flac")), false);
  });

  test("a take that lands while an account is deleted emails nobody", { timeout: 60_000 }, async () => {
    const leaving = await signIn(t, "mid-deletion@example.test");
    const [{ id: userId }] = await t.ctx.sql<{ id: string }[]>`select id from users where email = 'mid-deletion@example.test'`;
    const { id, script } = await productionWithScript(t, leaving, SCENE, "Mid-deletion");
    const { joinUrl } = (await get(`/api/productions/${id}/join-link`, leaving)).json();
    const parts = script.characters.map((c: { id: string }) => c.id);
    const claim = (await send("POST", `/api/join/${joinUrl.split("/join/")[1]}/claim`, { firstName: "Riz", characterIds: parts }, leaving)).json();
    const inviteHeaders = invite(`https://app.test/i/${claim.inviteToken}`);
    for (const l of script.lines.filter((x: { kind: string }) => x.kind === "dialogue")) {
      const res = await t.app.inject({
        method: "PUT",
        url: `/api/invite/lines/${l.id}/take`,
        headers: { ...inviteHeaders, "content-type": "audio/wav", "x-take-id": randomUUID(), "x-duration-ms": "700" },
        payload: toneWav(0.7, 440),
      });
      assert.equal(res.statusCode, 200);
    }
    await t.ctx.jobs.idle();
    // As if the completion emails were still to go when the account went: every line is in.
    await t.ctx.sql`delete from notifications where production_id = ${id}`;
    await t.ctx.sql`update actors set email = 'riz@example.test', email_verified_at = now() where production_id = ${id}`;
    // Storage is down, so the recordings are still there when the jobs run.
    const ctx: Ctx = {
      ...t.ctx,
      storage: Object.assign(Object.create(Object.getPrototypeOf(t.ctx.storage)), t.ctx.storage, {
        deletePrefix: async () => {
          throw new Error("bucket unavailable");
        },
      }),
    };
    await deleteAccount(ctx, userId!);
    const before = t.mailer.sent.length;
    await notifyActorsDone(t.ctx, id);
    await notifyCastComplete(t.ctx, id);
    assert.equal(t.mailer.sent.length, before, "no email to the director's old address, its placeholder or the cast");
    assert.equal((await t.ctx.sql`select 1 from notifications where production_id = ${id}`).length, 0);
    assert.ok(!t.mailer.sent.some((m) => /deleted\.invalid/.test(m.to)));
  });
});

describe("retention worker", { skip: dbSkip }, () => {
  let t: TestApp;
  let director: string;
  let ownerId: string;
  const workers: RetentionWorker[] = [];
  const start = (ctx: Ctx, opts?: Parameters<typeof startRetentionWorker>[1]) => {
    const w = startRetentionWorker(ctx, opts);
    workers.push(w);
    return w;
  };
  const deleted = async (id: string) =>
    Boolean((await t.ctx.sql<{ at: Date | null }[]>`select content_deleted_at as at from productions where id = ${id}`)[0]?.at);

  before(async () => {
    t = await createTestApp();
    director = await signIn(t, "director@example.test");
    ownerId = (await t.ctx.sql<{ id: string }[]>`select id from users limit 1`)[0]!.id;
  });
  after(async () => {
    for (const w of workers) await w.stop();
    await t.close();
  });

  test("sends one query at startup, then none while idle, health checks included", { timeout: 30_000 }, async () => {
    const { ctx, queries } = counting(t.ctx);
    const worker = start(ctx);
    t.ctx.retention = worker;
    await waitFor(() => queries() === 1);
    await delay(2500);
    assert.equal(queries(), 1, "idle worker sent queries");
    assert.deepEqual(worker.state(), { dueAt: null, failed: false });

    // Nothing due: requests don't wake it, and health checks never reach it at all.
    assert.equal((await t.app.inject({ method: "GET", url: "/health" })).statusCode, 200);
    worker.touch();
    await delay(200);
    assert.equal(queries(), 1);
    await worker.stop();
  });

  test("reschedules when dates change, including an end moved earlier or into the past", { timeout: 30_000 }, async () => {
    const worker = start(t.ctx);
    t.ctx.retention = worker;
    await waitFor(() => worker.state().dueAt === null);
    const near = (expected: number) => Math.abs((worker.state().dueAt ?? 0) - expected) < 5000;

    const p = (
      await t.app.inject({ method: "POST", url: "/api/productions", headers: bearer(director), payload: { title: "Run", performanceEndsOn: day(40) } })
    ).json().production;
    await waitFor(() => near(deletionMoment(day(40))));

    await t.app.inject({ method: "PATCH", url: `/api/productions/${p.id}`, headers: bearer(director), payload: { performanceEndsOn: day(10) } });
    await waitFor(() => near(deletionMoment(day(10))));

    // Into the past, but within the week: deletion moves to 12:00 UTC six days from now... or less.
    await t.app.inject({ method: "PATCH", url: `/api/productions/${p.id}`, headers: bearer(director), payload: { performanceEndsOn: day(-1) } });
    await waitFor(() => near(deletionMoment(day(-1))));
    assert.ok(worker.state().dueAt! - Date.now() < RETENTION_DAYS * DAY_MS);
    assert.equal(await deleted(p.id), false);

    // Further back than the API allows (an older production, or time passing): deleted on the next pass.
    await t.ctx.sql`update productions set performance_ends_on = ${day(-30)} where id = ${p.id}`;
    const moved = await t.app.inject({ method: "PATCH", url: `/api/productions/${p.id}`, headers: bearer(director), payload: { performanceEndsOn: day(30) } });
    assert.equal(moved.statusCode, 409, "a due show's final date can't move");
    worker.kick();
    await waitFor(() => deleted(p.id));
    await waitFor(() => worker.state().dueAt === null);
    await worker.stop();
  });

  test("chains timers past setTimeout's limit without queries, and deletes when the time comes", { timeout: 30_000 }, async () => {
    const [p] = await t.ctx.sql<{ id: string }[]>`
      insert into productions (owner_id, title, performance_ends_on) values (${ownerId}, 'Long run', ${day(60)}) returning id`;
    let offset = 0;
    const { ctx, queries } = counting(t.ctx);
    const worker = start(ctx, { clock: () => Date.now() + offset, maxSleepMs: 50 });
    await waitFor(() => worker.state().dueAt !== null);
    const settled = queries();
    assert.equal(settled, 1);
    await delay(1000);
    assert.equal(queries(), settled, "re-arming a long wait sends no queries");

    // Time passes: the final performance is now long gone, and the chained timer fires the pass.
    await t.ctx.sql`update productions set performance_ends_on = ${day(-60)} where id = ${p!.id}`;
    offset = 70 * DAY_MS;
    await waitFor(() => deleted(p!.id));
    await worker.stop();
  });

  test("catches up alongside a real request when a pass is overdue", { timeout: 30_000 }, async () => {
    const [p] = await t.ctx.sql<{ id: string }[]>`
      insert into productions (owner_id, title, performance_ends_on) values (${ownerId}, 'Missed timer', ${day(5)}) returning id`;
    let offset = 0;
    const worker = start(t.ctx, { clock: () => Date.now() + offset, maxSleepMs: 2 ** 31 - 1 });
    t.ctx.retention = worker;
    await waitFor(() => worker.state().dueAt !== null);
    // The timer is days away (a sleeping host would miss it); the clock jumps past it.
    await t.ctx.sql`update productions set performance_ends_on = ${day(-60)} where id = ${p!.id}`;
    offset = 30 * DAY_MS;
    assert.equal((await t.app.inject({ method: "GET", url: "/health" })).statusCode, 200);
    await delay(200);
    assert.equal(await deleted(p!.id), false, "health checks don't trigger it");
    await t.app.inject({ method: "GET", url: "/api/productions", headers: bearer(director) });
    await waitFor(() => deleted(p!.id));
    await worker.stop();
  });

  test("dueContent lists what is due and how long until the next", async () => {
    const [due] = await t.ctx.sql<{ id: string }[]>`
      insert into productions (owner_id, title, performance_ends_on) values (${ownerId}, 'Due', ${day(-8)}) returning id`;
    const [later] = await t.ctx.sql<{ id: string }[]>`
      insert into productions (owner_id, title, performance_ends_on) values (${ownerId}, 'Later', ${day(3)}) returning id`;
    const { dueIds, nextMs } = await dueContent(t.ctx.sql);
    assert.ok(dueIds.includes(due!.id) && !dueIds.includes(later!.id));
    assert.ok(nextMs !== null && Math.abs(Date.now() + nextMs - deletionMoment(day(3))) < 5000);
  });
});
