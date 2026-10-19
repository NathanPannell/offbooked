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
import { FakeSynthesizer } from "../test/tts.ts";

interface Line {
  id: string;
  kind: string;
  characterId: string | null;
  sectionId: string;
  text: string;
}
interface Timing {
  lineId: string;
  startMs: number;
  endMs: number;
  recorded: boolean;
  source: string;
}

describe("stand-ins and TTS", { skip: dbSkip }, () => {
  let t: TestApp;
  let fake: FakeSynthesizer;
  let alice: string;
  let bob: string;
  let pid: string;
  let lines: Line[];
  let chars: Map<string, string>;
  let hamlet: { id: string; inviteUrl: string };
  let horatio: { id: string; inviteUrl: string };
  let wav: Buffer;

  const linesOf = (name: string) => lines.filter((l) => l.kind === "dialogue" && l.characterId === chars.get(name));
  const dialogue = () => lines.filter((l) => l.kind === "dialogue");
  const put = (url: string, headers: Record<string, string>, takeId: string = randomUUID()) =>
    t.app.inject({ method: "PUT", url, headers: { ...headers, "content-type": "audio/wav", "x-take-id": takeId, "x-duration-ms": "700" }, payload: wav });
  const standin = (lineId: string, token = alice, takeId?: string) => put(`/api/lines/${lineId}/take`, bearer(token), takeId);
  const actorTake = (who: { inviteUrl: string }, lineId: string) => put(`/api/invite/lines/${lineId}/take`, invite(who.inviteUrl));
  const get = (url: string, token = alice) => t.app.inject({ method: "GET", url, headers: bearer(token) });
  const runthrough = async (id = pid) => (await get(`/api/productions/${id}/runthrough`)).json();
  const render = async () => {
    await t.ctx.sql`update renders set run_after = now() where status = 'queued'`;
    await processDueRenders(t.ctx);
    return (await runthrough()).render as { status: string; stale: boolean; timing: Timing[] };
  };

  before(async () => {
    fake = new FakeSynthesizer();
    t = await createTestApp({ synthesizer: fake });
    const dir = await mkdtemp(path.join(tmpdir(), "offbooked-take-"));
    await makeTone(0.7, 440, path.join(dir, "take.wav"));
    wav = await readFile(path.join(dir, "take.wav"));
    await rm(dir, { recursive: true, force: true });

    alice = await signIn(t, "alice@example.test");
    bob = await signIn(t, "bob@example.test");
    const made = await productionWithScript(t, alice, SEED_SCENE, "Hamlet");
    pid = made.id;
    lines = made.script.lines;
    chars = new Map(made.script.characters.map((c: { name: string; id: string }) => [c.name, c.id]));
    const cast = async (name: string, characterIds: string[]) =>
      (await t.app.inject({ method: "POST", url: `/api/productions/${pid}/cast`, headers: bearer(alice), payload: { name, characterIds } })).json().member;
    hamlet = await cast("Riz", [chars.get("HAMLET")!]);
    horatio = await cast("Jo", [chars.get("HORATIO")!, chars.get("MARCELLUS")!]);
  });
  after(() => t.close());

  test("the first run-through of a fresh script is all TTS, with one voice per character", async () => {
    const first = await runthrough();
    assert.equal(first.render.status, "queued", "opening the run-through queues the first render");
    const rt = await render();
    assert.equal(rt.status, "ready");
    assert.equal(rt.stale, false);
    assert.equal(rt.timing.length, dialogue().length);
    assert.ok(
      rt.timing.every((e) => e.source === "tts" && !e.recorded && e.endMs > e.startMs),
      JSON.stringify(rt.timing.slice(0, 3)),
    );
    // The fake speaks 250 ms per word; trimmed and loudness-normalized, the clip keeps about that length.
    const first3 = rt.timing[0]!;
    const words = dialogue()[0]!.text.split(/\s+/).length;
    assert.ok(Math.abs(first3.endMs - first3.startMs - words * 250) < 150, `${first3.endMs - first3.startMs} ms for ${words} words`);

    const synthesized = fake.calls.length;
    assert.equal(synthesized, new Set(dialogue().map((l) => `${l.characterId}|${l.text}`)).size);
    const voiceOf = new Map<string, Set<string>>();
    for (const call of fake.calls) {
      const line = dialogue().find((l) => l.text.replace(/\s+/g, " ").includes(call.text.slice(0, 30)))!;
      voiceOf.set(line.characterId!, (voiceOf.get(line.characterId!) ?? new Set()).add(call.voice));
    }
    assert.ok(
      [...voiceOf.values()].every((v) => v.size === 1),
      "each character keeps one voice",
    );
    assert.equal(new Set([...voiceOf.values()].map((v) => [...v][0])).size, voiceOf.size, "characters get different voices");

    // A forced rebuild reuses every cached clip.
    await t.app.inject({ method: "POST", url: `/api/productions/${pid}/render`, headers: bearer(alice) });
    await render();
    assert.equal(fake.calls.length, synthesized);

    // Editing an unrecorded line makes the render stale; opening the run-through rebuilds it and
    // only that line is synthesized again.
    const edited = dialogue()[1]!;
    await t.app.inject({ method: "PATCH", url: `/api/lines/${edited.id}`, headers: bearer(alice), payload: { text: "Something else entirely now." } });
    const stale = await runthrough();
    assert.equal(stale.render.stale, true);
    assert.equal(stale.render.status, "queued");
    assert.equal((await render()).stale, false);
    assert.equal(fake.calls.length, synthesized + 1);
    assert.equal(fake.calls.at(-1)!.text, "Something else entirely now.");
  });

  test("a director can record stand-ins only for lines in their own productions", async () => {
    const line = linesOf("HAMLET")[0]!;
    const takeId = randomUUID();
    const res = await standin(line.id, alice, takeId);
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json();
    assert.equal(body.take.id, takeId);
    assert.equal(body.take.recordedBy, "standin");
    assert.deepEqual([body.linesRecorded, body.linesTotal], [0, dialogue().length], "stand-ins don't count as recorded");
    assert.equal((await standin(line.id, alice, takeId)).json().take.id, takeId, "a repeated X-Take-Id returns the same take");
    const [{ n }] = await t.ctx.sql<{ n: number }[]>`select count(*)::int as n from takes where id = ${takeId}`;
    assert.equal(n, 1);
    const [queued] = await t.ctx.sql`select 1 from renders where production_id = ${pid} and status = 'queued'`;
    assert.ok(queued, "a stand-in schedules the debounced render");

    assert.equal((await standin(line.id, bob)).statusCode, 404, "another director's line");
    assert.equal((await standin(line.id, bob, takeId)).statusCode, 404, "another director can't replay a take id either");
    const other = await productionWithScript(t, bob, "ANNA: Hello there.\nBEN: Hi.", "Bob's show");
    const bobLine = other.script.lines.find((l: Line) => l.kind === "dialogue")!;
    assert.equal((await standin(bobLine.id, bob, takeId)).statusCode, 409, "a take id belongs to one recording");
    assert.equal((await standin(bobLine.id, alice)).statusCode, 404);
    assert.equal((await put(`/api/lines/${line.id}/take`, invite(hamlet.inviteUrl))).statusCode, 401, "actor tokens can't record stand-ins");
    assert.equal((await put(`/api/lines/${line.id}/take`, {})).statusCode, 401);
    const direction = lines.find((l) => l.kind === "stage_direction")!;
    assert.equal((await standin(direction.id)).statusCode, 404, "only dialogue has takes");
    const bad = await t.app.inject({
      method: "PUT",
      url: `/api/lines/${line.id}/take`,
      headers: { ...bearer(alice), "content-type": "text/plain", "x-take-id": randomUUID() },
      payload: "x",
    });
    assert.equal(bad.statusCode, 415);
  });

  test("progress, actor-done emails and cast completion count only the cast actor's takes", async () => {
    const mine = [...linesOf("HORATIO"), ...linesOf("MARCELLUS")];
    for (const l of mine) assert.equal((await standin(l.id)).statusCode, 200);
    await t.ctx.jobs.idle();
    const member = async () =>
      (await get(`/api/productions/${pid}/cast`)).json().cast.find((m: { id: string }) => m.id === horatio.id) as {
        status: string;
        linesRecorded: number;
        linesTotal: number;
      };
    assert.equal((await member()).linesRecorded, 0);
    assert.equal((await member()).status, "not_opened");
    assert.equal((await get(`/api/productions/${pid}`)).json().production.progress.linesRecorded, 0);
    assert.equal((await t.app.inject({ method: "GET", url: "/api/invite", headers: invite(horatio.inviteUrl) })).json().linesRecorded, 0);
    assert.ok(!t.mailer.sent.some((m) => m.subject.includes("finished all")), "no actor-done email for stand-ins");

    // The actor records their own lines: their takes become current and count.
    const own = (await t.app.inject({ method: "GET", url: "/api/invite/lines", headers: invite(horatio.inviteUrl) })).json().lines;
    assert.ok(
      own.every((l: { take: unknown }) => l.take === null),
      "a stand-in isn't the actor's own take",
    );
    for (const l of mine) assert.equal((await actorTake(horatio, l.id)).statusCode, 200);
    await t.ctx.jobs.idle();
    assert.deepEqual([(await member()).linesRecorded, (await member()).status], [mine.length, "done"]);
    assert.ok(t.mailer.sent.some((m) => m.subject === `Jo finished all ${mine.length} lines`));

    // Every cast line now has a take, but Hamlet's are stand-ins: no cast-complete email.
    for (const l of linesOf("HAMLET")) await standin(l.id);
    const rt = await render();
    const byLine = new Map(rt.timing.map((e) => [e.lineId, e]));
    assert.ok(mine.every((l) => byLine.get(l.id)!.source === "actor"));
    assert.ok(
      linesOf("HAMLET").every((l) => byLine.get(l.id)!.source === "standin" && byLine.get(l.id)!.recorded),
      "stand-ins fill the run-through",
    );
    assert.ok(!t.mailer.sent.some((m) => m.subject.startsWith("Cast complete")), "Hamlet's lines are only stand-ins");

    // A later stand-in is newest and plays, but the actor's progress stays.
    await standin(mine[0]!.id);
    assert.equal((await member()).linesRecorded, mine.length);
    const progress = (await get(`/api/productions/${pid}`)).json().production.progress;
    assert.deepEqual([progress.linesRecorded, progress.actorsDone], [mine.length, 1]);
  });

  test("section lines and actor cues carry their audio source", async () => {
    const section = lines[0]!.sectionId;
    const res = await get(`/api/productions/${pid}/sections/${section}/lines`);
    assert.equal(res.statusCode, 200, res.body);
    const body = res.json();
    assert.equal(body.section.id, section);
    assert.equal(body.lines.length, dialogue().filter((l) => l.sectionId === section).length);
    const row = (b: { lines: { line: { id: string } }[] }, lineId: string) =>
      b.lines.find((l) => l.line.id === lineId) as unknown as {
        characterName: string;
        audioSource: string;
        take: { recordedBy: string } | null;
        cue: { characterName: string; text: string; audioUrl: string | null; audioSource: string };
      };
    const first = row(body, linesOf("HAMLET")[0]!.id);
    assert.equal(first.characterName, "HAMLET");
    assert.equal(first.audioSource, "standin");
    assert.equal(first.take!.recordedBy, "standin");
    assert.equal(first.cue.characterName, "KING");
    assert.equal(row(body, linesOf("HORATIO")[1]!.id).audioSource, "actor");
    assert.equal((await get(`/api/productions/${pid}/sections/${section}/lines`, bob)).statusCode, 404);
    assert.equal((await get(`/api/productions/${pid}/sections/${randomUUID()}/lines`)).statusCode, 404);

    // A cue nobody recorded is spoken by TTS, as an .m4a any browser plays. Clips that aren't ready
    // within the short wait come back as "none" and keep synthesizing in the background.
    const king = row(body, linesOf("KING")[0]!.id);
    assert.deepEqual([king.take, king.audioSource], [null, "tts"]);
    await t.ctx.jobs.idle();
    const again = (await get(`/api/productions/${pid}/sections/${section}/lines`)).json();
    const cue = row(again, linesOf("LAERTES")[0]!.id).cue;
    assert.equal(cue.audioSource, "tts");
    const url = new URL(cue.audioUrl!);
    assert.match(url.pathname, /\/api\/files\/tts\/[0-9a-f]{64}\.m4a$/);
    const audio = await t.app.inject({ method: "GET", url: url.pathname + url.search, headers: { range: "bytes=0-9" } });
    assert.equal(audio.statusCode, 206);
    assert.equal(audio.headers["content-type"], "audio/mp4");

    // Once the director stands in for the cue line, the cue plays that take.
    const cueLine = lines.find((l) => l.text === first.cue.text)!;
    await standin(cueLine.id);
    const withStandin = (await get(`/api/productions/${pid}/sections/${section}/lines`)).json();
    assert.equal(row(withStandin, linesOf("HAMLET")[0]!.id).cue.audioSource, "standin");

    const hamletLines = (await t.app.inject({ method: "GET", url: "/api/invite/lines", headers: invite(hamlet.inviteUrl) })).json().lines;
    const sources = new Set(hamletLines.map((l: { cue: { audioSource: string } | null }) => l.cue?.audioSource));
    assert.ok(
      [...sources].every((s) => s === "actor" || s === "standin" || s === "tts"),
      [...sources].join(),
    );
  });

  test("without TTS the run-through falls back to silence", async () => {
    fake.available = false;
    try {
      await t.ctx.sql`update lines set current_take_id = null where production_id = ${pid}`;
      await t.app.inject({ method: "POST", url: `/api/productions/${pid}/render`, headers: bearer(alice) });
      const rt = await render();
      assert.ok(rt.timing.every((e) => e.source === "none" && !e.recorded));
      const health = await t.app.inject({ method: "GET", url: "/health" });
      assert.equal(health.statusCode, 200);
      assert.equal(health.json().tts, null);
    } finally {
      fake.available = true;
    }
    assert.equal((await t.app.inject({ method: "GET", url: "/health" })).json().tts, "fake 1");
  });
});
