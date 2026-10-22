import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { makeTone } from "../render/ffmpeg.ts";
import { processDueRenders } from "../render/queue.ts";
import { SEED_SCENE } from "../seed-scene.ts";
import { bearer, createTestApp, dbSkip, invite, productionWithScript, signIn, type TestApp } from "../test/helpers.ts";

interface Line {
  id: string;
  kind: string;
  characterId: string | null;
  text: string;
}

describe("actor invites, takes and the run-through", { skip: dbSkip }, () => {
  let t: TestApp;
  let director: string;
  let pid: string;
  let lines: Line[];
  let chars: Map<string, string>;
  let hamlet: { id: string; inviteUrl: string };
  let horatio: { id: string; inviteUrl: string };
  let outsider: { inviteUrl: string };
  let wav: Buffer;

  const as = (who: { inviteUrl: string }) => invite(who.inviteUrl);
  const linesOf = (name: string) => lines.filter((l) => l.kind === "dialogue" && l.characterId === chars.get(name));
  const upload = (who: { inviteUrl: string }, lineId: string, takeId = randomUUID(), audio = wav, type = "audio/wav") =>
    t.app.inject({
      method: "PUT",
      url: `/api/invite/lines/${lineId}/take`,
      headers: { ...as(who), "content-type": type, "x-take-id": takeId, "x-duration-ms": "700" },
      payload: audio,
    });

  before(async () => {
    t = await createTestApp();
    const dir = await mkdtemp(path.join(tmpdir(), "offbooked-take-"));
    await makeTone(0.7, 440, path.join(dir, "take.wav"));
    wav = await readFile(path.join(dir, "take.wav"));
    await rm(dir, { recursive: true, force: true });

    director = await signIn(t, "director@example.test");
    await t.app.inject({ method: "PATCH", url: "/api/me", headers: bearer(director), payload: { name: "Sam" } });
    const made = await productionWithScript(t, director, SEED_SCENE, "Hamlet");
    pid = made.id;
    lines = made.script.lines;
    chars = new Map(made.script.characters.map((c: { name: string; id: string }) => [c.name, c.id]));
    const cast = async (production: string, name: string, characterIds: string[], email?: string) =>
      (
        await t.app.inject({ method: "POST", url: `/api/productions/${production}/cast`, headers: bearer(director), payload: { name, email, characterIds } })
      ).json().member;
    hamlet = await cast(pid, "Riz", [chars.get("HAMLET")!]);
    horatio = await cast(pid, "Jo", [chars.get("HORATIO")!, chars.get("MARCELLUS")!], "jo@example.test");
    const other = await productionWithScript(t, director, "ANNA: Hello there.\nBEN: Hi.", "Other");
    outsider = await cast(other.id, "Pat", [other.script.characters[0].id]);
  });
  after(() => t.close());

  test("invite summary and start", async () => {
    const res = await t.app.inject({ method: "GET", url: "/api/invite", headers: as(hamlet) });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.deepEqual(body.production, { id: pid, title: "Hamlet", directorName: "Sam" });
    assert.deepEqual(body.characters, [{ id: chars.get("HAMLET"), name: "HAMLET" }]);
    assert.equal(body.linesTotal, linesOf("HAMLET").length);
    assert.equal(body.hasEmail, false);
    const start = await t.app.inject({ method: "POST", url: "/api/invite/start", headers: as(hamlet), payload: { firstName: "Riz" } });
    assert.equal(start.statusCode, 204);
    const cast = (await t.app.inject({ method: "GET", url: `/api/productions/${pid}/cast`, headers: bearer(director) })).json().cast;
    assert.equal(cast.find((m: { id: string }) => m.id === hamlet.id).status, "opened");
  });

  test("an actor sees only their own lines plus one cue line each", async () => {
    const res = (await t.app.inject({ method: "GET", url: "/api/invite/lines", headers: as(horatio) })).json();
    const mine = [...linesOf("HORATIO"), ...linesOf("MARCELLUS")].map((l) => l.id).sort();
    assert.deepEqual(res.lines.map((l: { line: { id: string } }) => l.line.id).sort(), mine);
    const visible = new Set<string>();
    for (const item of res.lines) {
      visible.add(item.line.text);
      if (item.cue) visible.add(item.cue.text);
    }
    const others = lines.filter((l) => l.kind === "dialogue" && !mine.includes(l.id));
    const leaked = others.filter((l) => visible.has(l.text));
    assert.ok(leaked.length <= res.lines.length, "only cue lines of other characters are visible");
    const first = res.lines[0];
    assert.equal(first.cue.characterName, "HAMLET");
    assert.equal(
      first.cue.text,
      "O that this too too solid flesh would melt, Thaw, and resolve itself into a dew! How weary, stale, flat, and unprofitable Seem to me all the uses of this world! But break my heart, for I must hold my tongue.",
    );
    assert.deepEqual(first.directions, ["[Enter Horatio, Marcellus and Bernardo.]"]);
    assert.equal(first.take, null);
    assert.equal(first.sectionTitle, "Act 1, Scene 2");
  });

  test("actor tokens cannot reach director endpoints, other lines or other productions", async () => {
    assert.equal((await t.app.inject({ method: "GET", url: `/api/productions/${pid}`, headers: as(hamlet) })).statusCode, 401);
    assert.equal((await t.app.inject({ method: "GET", url: `/api/productions/${pid}/script`, headers: as(hamlet) })).statusCode, 401);
    assert.equal((await upload(hamlet, linesOf("HORATIO")[0]!.id)).statusCode, 404, "cannot record someone else's line");
    assert.equal((await upload(outsider, linesOf("HAMLET")[0]!.id)).statusCode, 404, "cannot record in another production");
    const otherLines = (await t.app.inject({ method: "GET", url: "/api/invite/lines", headers: as(outsider) })).json().lines;
    assert.ok(otherLines.every((l: { line: { text: string } }) => !lines.some((x) => x.text === l.line.text)));
    const practice = await t.app.inject({
      method: "POST",
      url: "/api/invite/practice",
      headers: as(hamlet),
      payload: { mode: "my_part", results: [{ lineId: linesOf("HORATIO")[0]!.id, transcript: "x", accuracy: 1, ops: [] }] },
    });
    assert.equal(practice.statusCode, 400);
    const forged = hamlet.inviteUrl.slice(0, -3) + "abc";
    assert.equal((await t.app.inject({ method: "GET", url: "/api/invite", headers: invite(forged) })).statusCode, 401);
  });

  test("take upload is idempotent, keeps old takes and serves audio with Range", async () => {
    const line = linesOf("HAMLET")[0]!;
    const takeId = randomUUID();
    const first = await upload(hamlet, line.id, takeId);
    assert.equal(first.statusCode, 200, first.body);
    const body = first.json();
    assert.equal(body.take.id, takeId);
    assert.equal(body.linesRecorded, 1);
    assert.ok(Math.abs(body.take.durationMs - 700) < 60, `duration probed: ${body.take.durationMs}`);
    const repeat = await upload(hamlet, line.id, takeId);
    assert.equal(repeat.json().take.id, takeId);
    assert.equal(repeat.json().linesRecorded, 1);
    assert.equal(Number((await t.ctx.sql`select count(*)::int as n from takes`)[0]!.n), 1);
    assert.equal((await upload(horatio, linesOf("HORATIO")[0]!.id, takeId)).statusCode, 409, "a take id belongs to one recording");

    const second = (await upload(hamlet, line.id)).json();
    assert.notEqual(second.take.id, takeId);
    const [{ n }] = await t.ctx.sql<{ n: number }[]>`select count(*)::int as n from takes where line_id = ${line.id}`;
    assert.equal(n, 2, "re-records keep earlier takes");
    const mine = (await t.app.inject({ method: "GET", url: "/api/invite/lines", headers: as(hamlet) })).json().lines;
    assert.equal(mine.find((l: { line: { id: string } }) => l.line.id === line.id).take.id, second.take.id);

    const url = new URL(second.take.audioUrl);
    const full = await t.app.inject({ method: "GET", url: url.pathname + url.search });
    assert.equal(full.statusCode, 200);
    assert.equal(full.headers["cross-origin-resource-policy"], "cross-origin");
    assert.equal(full.rawPayload.length, wav.length);
    const part = await t.app.inject({ method: "GET", url: url.pathname + url.search, headers: { range: "bytes=0-99" } });
    assert.equal(part.statusCode, 206);
    assert.equal(part.headers["content-range"], `bytes 0-99/${wav.length}`);
    assert.equal(part.rawPayload.length, 100);
    assert.equal((await t.app.inject({ method: "GET", url: url.pathname + "?exp=1&sig=bad" })).statusCode, 403);

    assert.equal((await upload(hamlet, line.id, randomUUID(), Buffer.from("x"), "text/plain")).statusCode, 415);
    const stt = await t.app.inject({
      method: "POST",
      url: `/api/invite/takes/${second.take.id}/stt`,
      headers: as(hamlet),
      payload: { transcript: "a little more than kin", accuracy: 0.9, ops: [{ op: "ok", expected: "a", heard: "a" }] },
    });
    assert.equal(stt.statusCode, 204);
    const again = (await t.app.inject({ method: "GET", url: "/api/invite/lines", headers: as(hamlet) })).json().lines[0].take;
    assert.equal(again.stt.accuracy, 0.9);
    assert.equal(
      (await t.app.inject({ method: "POST", url: `/api/invite/takes/${second.take.id}/stt`, headers: as(horatio), payload: { transcript: "", accuracy: 1 } }))
        .statusCode,
      404,
    );
  });

  test("a take the bucket refuses is a 503 with Retry-After, and the same take goes up once storage is back", async () => {
    const line = linesOf("HORATIO")[0]!;
    const takeId = randomUUID();
    const put = t.ctx.storage.put;
    t.ctx.storage.put = async () => {
      throw new Error("AccessDenied");
    };
    try {
      const refused = await upload(horatio, line.id, takeId);
      assert.equal(refused.statusCode, 503);
      assert.equal(refused.json().error.code, "storage_unavailable");
      assert.equal(refused.headers["retry-after"], "30");
      const [row] = await t.ctx.sql`select count(*)::int as n from takes where id = ${takeId}`;
      assert.equal(row!.n, 0);
    } finally {
      t.ctx.storage.put = put;
    }
    const later = await upload(horatio, line.id, takeId);
    assert.equal(later.statusCode, 200);
    assert.equal(later.json().take.id, takeId);
  });

  test("too many uploads says when to try again", async () => {
    const line = linesOf("MARCELLUS")[0]!;
    await t.ctx.sql`insert into rate_limits (key, window_start, count)
      values (${`take:${horatio.id}`}, to_timestamp(floor(extract(epoch from now()) / 600) * 600), 1000)
      on conflict (key, window_start) do update set count = 1000`;
    try {
      const res = await upload(horatio, line.id);
      assert.equal(res.statusCode, 429);
      const wait = Number(res.headers["retry-after"]);
      assert.ok(wait >= 1 && wait <= 600, `Retry-After ${wait}`);
      const cors = await t.app.inject({
        method: "OPTIONS",
        url: `/api/invite/lines/${line.id}/take`,
        headers: { origin: "https://app.test", "access-control-request-method": "PUT" },
      });
      assert.equal(cors.statusCode, 204);
      const exposed = await t.app.inject({ method: "PUT", url: `/api/invite/lines/${line.id}/take`, headers: { ...as(horatio), origin: "https://app.test" } });
      assert.match(String(exposed.headers["access-control-expose-headers"]), /Retry-After/);
    } finally {
      await t.ctx.sql`delete from rate_limits where key = ${`take:${horatio.id}`}`;
    }
  });

  test("per-line take cap", async () => {
    const line = linesOf("MARCELLUS")[0]!;
    await t.ctx.sql`insert into takes (id, production_id, line_id, actor_id, storage_key, content_type, bytes, duration_ms)
      select gen_random_uuid(), ${pid}, ${line.id}, ${horatio.id}, (select storage_key from takes limit 1), 'audio/wav', 10, 100 from generate_series(1, 25)`;
    const res = await upload(horatio, line.id);
    assert.equal(res.statusCode, 409);
    assert.equal(res.json().error.code, "take_limit");
  });

  test("recordings stay attached through edits and block script replacement", async () => {
    const line = linesOf("HAMLET")[0]!;
    const edited = await t.app.inject({ method: "PATCH", url: `/api/lines/${line.id}`, headers: bearer(director), payload: { text: `${line.text} (edited)` } });
    assert.equal(edited.statusCode, 200);
    const mine = (await t.app.inject({ method: "GET", url: "/api/invite/lines", headers: as(hamlet) })).json().lines;
    assert.ok(mine.find((l: { line: { id: string } }) => l.line.id === line.id).take);
    const index = lines.findIndex((l) => l.id === line.id);
    const merge = await t.app.inject({ method: "POST", url: `/api/lines/${lines[index - 1]!.id}/merge-next`, headers: bearer(director) });
    assert.equal(merge.statusCode, 409);
    const replace = await t.app.inject({ method: "POST", url: `/api/productions/${pid}/script`, headers: bearer(director), payload: { text: "A: new" } });
    assert.equal(replace.statusCode, 409);
    assert.equal(replace.json().error.code, "has_recordings");
  });

  test("render, run-through, stale flag and completion emails", async () => {
    // Horatio records everything; Hamlet's other lines stay unrecorded for now.
    for (const l of [...linesOf("HORATIO"), ...linesOf("MARCELLUS")]) {
      if (l.id === linesOf("MARCELLUS")[0]!.id) continue;
      assert.equal((await upload(horatio, l.id)).statusCode, 200);
    }
    await t.ctx.sql`update lines set current_take_id = (select id from takes t where t.line_id = lines.id limit 1) where id = ${linesOf("MARCELLUS")[0]!.id}`;
    await t.ctx.jobs.idle();

    const before = (await t.app.inject({ method: "GET", url: `/api/productions/${pid}/runthrough`, headers: bearer(director) })).json();
    assert.equal(before.render.status, "queued");
    await t.ctx.sql`update renders set run_after = now()`;
    assert.equal(await processDueRenders(t.ctx), 1);
    const rt = (await t.app.inject({ method: "GET", url: `/api/productions/${pid}/runthrough`, headers: bearer(director) })).json();
    assert.equal(rt.render.status, "ready", JSON.stringify(rt.render));
    assert.equal(rt.render.stale, false);
    assert.equal(rt.render.timing.length, lines.filter((l) => l.kind === "dialogue").length);
    assert.deepEqual(rt.myCharacterIds, []);
    const recorded = rt.render.timing.filter((e: { recorded: boolean }) => e.recorded).length;
    assert.equal(recorded, linesOf("HORATIO").length + linesOf("MARCELLUS").length + 1);
    const audio = new URL(rt.render.audioUrl);
    const ranged = await t.app.inject({ method: "GET", url: audio.pathname + audio.search, headers: { range: "bytes=0-1" } });
    assert.equal(ranged.statusCode, 206);
    assert.equal(ranged.headers["content-type"], "audio/mp4");

    const actorView = (await t.app.inject({ method: "GET", url: "/api/invite/runthrough", headers: as(horatio) })).json();
    assert.deepEqual(actorView.myCharacterIds.sort(), [chars.get("HORATIO"), chars.get("MARCELLUS")].sort());
    assert.equal(actorView.lines.length, lines.length);

    // Hamlet finishes: actor-done email, then the full-cast render sends the completion emails once.
    for (const l of linesOf("HAMLET").slice(1)) assert.equal((await upload(hamlet, l.id)).statusCode, 200);
    await t.ctx.jobs.idle();
    const stale = (await t.app.inject({ method: "GET", url: `/api/productions/${pid}/runthrough`, headers: bearer(director) })).json();
    assert.equal(stale.render.stale, true);
    assert.ok(t.mailer.sent.some((m) => m.subject === `Riz finished all ${linesOf("HAMLET").length} lines` && m.to === "director@example.test"));

    const forced = await t.app.inject({ method: "POST", url: `/api/productions/${pid}/render`, headers: bearer(director) });
    assert.equal(forced.statusCode, 202);
    assert.equal(forced.json().render.status, "queued");
    await processDueRenders(t.ctx);
    const subjects = t.mailer.sent.map((m) => `${m.to}: ${m.subject}`);
    assert.ok(subjects.includes("director@example.test: Cast complete — ready to listen through"), subjects.join("\n"));
    assert.ok(subjects.includes("jo@example.test: Hamlet is ready to listen through"));
    const actorEmail = t.mailer.sent.find((m) => m.to === "jo@example.test")!;
    assert.ok(actorEmail.text.includes(`${horatio.inviteUrl}/play`));
    assert.ok(actorEmail.headers?.["List-Unsubscribe"]);

    const count = t.mailer.sent.length;
    await t.app.inject({ method: "POST", url: `/api/productions/${pid}/render`, headers: bearer(director) });
    await processDueRenders(t.ctx);
    assert.equal(t.mailer.sent.length, count, "completion emails send once");
    const progress = (await t.app.inject({ method: "GET", url: `/api/productions/${pid}`, headers: bearer(director) })).json().production.progress;
    assert.equal(progress.actorsDone, 2);

    const unsubscribe = new URL(/Unsubscribe: (\S+)/.exec(actorEmail.text)![1]!);
    assert.equal((await t.app.inject({ method: "GET", url: unsubscribe.pathname + unsubscribe.search })).statusCode, 200);
    const oneClick = await t.app.inject({
      method: "POST",
      url: unsubscribe.pathname + unsubscribe.search,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: "List-Unsubscribe=One-Click",
    });
    assert.equal(oneClick.statusCode, 200, "the one-click List-Unsubscribe form post");
  });

  test("practice runs and contact email", async () => {
    const mine = linesOf("HAMLET").slice(0, 2);
    const res = await t.app.inject({
      method: "POST",
      url: "/api/invite/practice",
      headers: as(hamlet),
      payload: { mode: "my_part", results: mine.map((l, i) => ({ lineId: l.id, transcript: l.text, accuracy: i ? 0.5 : 1, ops: [] })) },
    });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().practice.avgAccuracy, 0.75);
    const contact = await t.app.inject({ method: "POST", url: "/api/invite/contact", headers: as(hamlet), payload: { email: "riz@example.test" } });
    assert.equal(contact.statusCode, 200);
    assert.equal((await t.app.inject({ method: "GET", url: "/api/invite", headers: as(hamlet) })).json().hasEmail, false, "not until it is confirmed");
    const link = new URL(contact.json().devLink);
    assert.equal((await t.app.inject({ method: "GET", url: link.pathname + link.search })).statusCode, 200);
    assert.equal((await t.app.inject({ method: "GET", url: "/api/invite", headers: as(hamlet) })).json().hasEmail, false, "opening the link isn't enough");
    const confirm = await t.app.inject({ method: "POST", url: link.pathname, payload: Object.fromEntries(link.searchParams) });
    assert.equal(confirm.statusCode, 200, "the Confirm button's fields work as JSON too");
    assert.equal((await t.app.inject({ method: "GET", url: "/api/invite", headers: as(hamlet) })).json().hasEmail, true);
  });

  test("reset and archived links are gone with context", async () => {
    const reset = (await t.app.inject({ method: "POST", url: `/api/cast/${horatio.id}/reset-link`, headers: bearer(director) })).json().member;
    const old = await t.app.inject({ method: "GET", url: "/api/invite", headers: as(horatio) });
    assert.equal(old.statusCode, 410);
    assert.deepEqual(
      { directorName: old.json().directorName, productionTitle: old.json().productionTitle },
      { directorName: "Sam", productionTitle: "Hamlet" },
    );
    assert.equal((await t.app.inject({ method: "GET", url: "/api/invite", headers: invite(reset.inviteUrl) })).statusCode, 200);

    // The API refuses a final date this far back; an old production (or time passing) has one.
    const [{ endsOn }] = await t.ctx.sql<{ endsOn: string }[]>`select performance_ends_on::text as ends_on from productions where id = ${pid}`;
    await t.ctx.sql`update productions set performance_ends_on = '2020-01-01' where id = ${pid}`;
    assert.equal(
      (await t.app.inject({ method: "GET", url: "/api/invite", headers: invite(reset.inviteUrl) })).statusCode,
      410,
      "expired when the content is due for deletion, 7 days after the final performance",
    );
    await t.ctx.sql`update productions set performance_ends_on = ${endsOn} where id = ${pid}`;
    await t.app.inject({ method: "POST", url: `/api/productions/${pid}/archive`, headers: bearer(director) });
    const archived = await t.app.inject({ method: "GET", url: "/api/invite", headers: invite(reset.inviteUrl) });
    assert.equal(archived.statusCode, 410);
    assert.equal(archived.json().error.code, "invite_expired");
  });
});
