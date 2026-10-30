import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { Ctx } from "../context.ts";
import { resolveLineAudio } from "../linestream.ts";
import { makeTone } from "../render/ffmpeg.ts";
import { bearer, createTestApp, dbSkip, invite, productionWithScript, signIn, type TestApp } from "../test/helpers.ts";
import { FakeSynthesizer } from "../test/tts.ts";
import { TTS_PRIORITY } from "../tts/service.ts";
import { listenTrack, MAX_TRACK_LINES, pruneTracks, RETRY_FAILED_MS, trackRequest } from "./track.ts";

interface Line {
  id: string;
  kind: string;
  characterId: string | null;
}

interface Item {
  lineId: string;
  kind: "line" | "speak";
  startMs: number;
  durationMs: number;
  source?: string;
}

test("a track request lists lines, optionally the listener's, and a mode", () => {
  const id = randomUUID();
  assert.deepEqual(trackRequest({ lineIds: [id.toUpperCase(), id] }), { lineIds: [id], mine: new Set(), mode: "read" });
  assert.equal(trackRequest({ lineIds: [id], mine: [id], mode: "pause" }).mode, "pause");
  assert.throws(() => trackRequest({ lineIds: [] }), /at least one/);
  assert.throws(() => trackRequest({ lineIds: ["nope"] }), /list of ids/);
  assert.throws(() => trackRequest({ lineIds: Array.from({ length: MAX_TRACK_LINES + 1 }, () => randomUUID()) }), /at most/);
  assert.throws(() => trackRequest({ lineIds: [id], mode: "loud" }), /mode must be/);
});

describe("listen tracks", { skip: dbSkip }, () => {
  let t: TestApp;
  let alice: string;
  let bob: string;
  let pid: string;
  let lines: Line[];
  let anna: { inviteUrl: string };
  let annaId: string;
  let wav: Buffer;
  const dialogue = () => lines.filter((l) => l.kind === "dialogue");
  const ask = (payload: unknown, headers: Record<string, string> = bearer(alice), url = `/api/productions/${pid}/listen-track`) =>
    t.app.inject({ method: "POST", url, headers, payload: payload as Record<string, unknown> });
  // Asks, waits for the build, and asks again: the ready track.
  const built = async (payload: unknown, headers?: Record<string, string>, url?: string) => {
    const first = await ask(payload, headers, url);
    assert.equal(first.statusCode, 200, first.body);
    await t.ctx.jobs.idle();
    const res = await ask(payload, headers, url);
    assert.equal(res.statusCode, 200, res.body);
    const track = res.json().track as { status: string; url: string; durationMs: number; items: Item[] };
    assert.equal(track.status, "ready", res.body);
    return track;
  };
  const fileOf = (url: string) => t.app.inject({ method: "GET", url: new URL(url).pathname + new URL(url).search });

  before(async () => {
    t = await createTestApp({ synthesizer: new FakeSynthesizer() });
    const dir = await mkdtemp(path.join(tmpdir(), "offbooked-take-"));
    await makeTone(0.7, 440, path.join(dir, "take.wav"));
    wav = await readFile(path.join(dir, "take.wav"));
    await rm(dir, { recursive: true, force: true });
    alice = await signIn(t, "alice@example.test");
    bob = await signIn(t, "bob@example.test");
    const made = await productionWithScript(
      t,
      alice,
      "ANNA: Hello there, how are you today.\nBEN: Very well, thank you.\nANNA: I am glad to hear it.",
      "Track show",
    );
    pid = made.id;
    lines = made.script.lines;
    annaId = made.script.characters.find((c: { name: string }) => c.name === "ANNA").id;
    anna = (
      await t.app.inject({ method: "POST", url: `/api/productions/${pid}/cast`, headers: bearer(alice), payload: { name: "Ana", characterIds: [annaId] } })
    ).json().member;
  });
  after(() => t.close());

  test("builds once in the background, then answers with the same file, its lines laid out like the player's", async () => {
    const lineIds = dialogue().map((l) => l.id);
    const first = await ask({ lineIds });
    assert.equal(first.statusCode, 200, first.body);
    assert.deepEqual(first.json(), { track: { status: "building" } });
    const track = await built({ lineIds });
    assert.deepEqual(
      track.items.map((i) => [i.lineId, i.kind, i.source]),
      lineIds.map((id) => [id, "line", "tts"]),
    );
    const [a, b, c] = track.items;
    assert.equal(b!.startMs, a!.durationMs + 350, "the player's pause between two lines of a scene");
    assert.ok(Math.abs(c!.startMs - (b!.startMs + b!.durationMs + 350)) <= 1);
    assert.ok(Math.abs(track.durationMs - (c!.startMs + c!.durationMs)) <= 1);
    const file = await fileOf(track.url);
    assert.equal(file.statusCode, 200);
    assert.equal(file.headers["content-type"], "audio/mp4");
    assert.ok(file.rawPayload.length > 1000);
    const again = (await ask({ lineIds })).json().track;
    assert.equal(new URL(again.url).pathname, new URL(track.url).pathname, "the same track, not built again");
    const rows = await t.ctx.sql`select 1 from listen_tracks where production_id = ${pid}`;
    assert.equal(rows.length, 1);
  });

  test("a cast member's track leaves their lines silent to say them, then plays them in 'Pause, then read'", async () => {
    const lineIds = dialogue().map((l) => l.id);
    const mine = dialogue()
      .filter((l) => l.characterId === annaId)
      .map((l) => l.id);
    const track = await built({ lineIds, mine, mode: "pause" }, invite(anna.inviteUrl), "/api/invite/listen-track");
    assert.deepEqual(
      track.items.map((i) => i.kind),
      ["speak", "line", "line", "speak", "line"],
    );
    const skip = await built({ lineIds, mine, mode: "skip" }, invite(anna.inviteUrl), "/api/invite/listen-track");
    assert.deepEqual(
      skip.items.map((i) => i.kind),
      ["speak", "line", "speak"],
    );
  });

  test("auth and scoping", async () => {
    const lineIds = dialogue().map((l) => l.id);
    assert.equal((await ask({ lineIds }, {})).statusCode, 401);
    assert.equal((await ask({ lineIds }, bearer(bob))).statusCode, 404, "another director's production");
    assert.equal((await ask({ lineIds }, bearer(alice), "/api/invite/listen-track")).statusCode, 401, "the invite route needs an invite token");
    assert.equal((await ask({ lineIds: [] })).statusCode, 400);
    assert.equal((await ask({ lineIds, mode: "loud" })).statusCode, 400);
    const other = await productionWithScript(t, bob, "CARL: Hello there.\nDORA: Hi.", "Bob's show");
    const elsewhere = other.script.lines.filter((l: Line) => l.kind === "dialogue").map((l: Line) => l.id);
    assert.equal((await ask({ lineIds: elsewhere })).statusCode, 400, "lines from another production can't be played here");
  });

  test("a new take makes a new track with the recording in it", async () => {
    const lineIds = dialogue().map((l) => l.id);
    const earlier = await built({ lineIds });
    const take = await t.app.inject({
      method: "PUT",
      url: `/api/invite/lines/${lineIds[0]}/take`,
      headers: { ...invite(anna.inviteUrl), "content-type": "audio/wav", "x-take-id": randomUUID(), "x-duration-ms": "700" },
      payload: wav,
    });
    assert.equal(take.statusCode, 200, take.body);
    assert.deepEqual((await ask({ lineIds })).json(), { track: { status: "building" } });
    const rebuilt = await built({ lineIds });
    assert.notEqual(new URL(rebuilt.url).pathname, new URL(earlier.url).pathname);
    assert.equal(rebuilt.items[0]!.source, "actor");
    assert.ok(Math.abs(rebuilt.items[0]!.durationMs - 700) < 150, String(rebuilt.items[0]!.durationMs));
  });

  test("tracks nobody has asked for in 12 hours go when another is built, files and all", async () => {
    const lineIds = dialogue().map((l) => l.id);
    const old = await built({ lineIds: lineIds.slice(0, 2) });
    const [row] = await t.ctx.sql<{ storageKey: string }[]>`
      update listen_tracks set used_at = now() - interval '13 hours' where production_id = ${pid} and status = 'ready' returning storage_key`;
    assert.ok(row && (await t.ctx.storage.exists(row.storageKey)));
    await built({ lineIds: lineIds.slice(1) });
    assert.equal((await fileOf(old.url)).statusCode, 404, "the old file is gone");
    const left = await t.ctx.sql`select 1 from listen_tracks where production_id = ${pid} and used_at < now() - interval '12 hours'`;
    assert.equal(left.length, 0);
    assert.equal(await pruneTracks(t.ctx, pid), 0, "nothing left to prune");
  });

  // Last: it deletes a clip's file.
  test("an idle server sends no queries after a build, and a failed track isn't built again when asked", { timeout: 60_000 }, async () => {
    // Counts every query the track code sends, so an idle server can be shown to send none.
    let queries = 0;
    const sql = new Proxy(t.ctx.sql, {
      apply(target, self, args) {
        queries++;
        return Reflect.apply(target, self, args);
      },
    });
    const ctx: Ctx = { ...t.ctx, sql };
    const settledFor = async (ms: number) => {
      await t.ctx.jobs.idle();
      await delay(100);
      const settled = queries;
      await delay(ms);
      assert.equal(queries, settled, "the server kept querying while idle");
    };
    const [, ben, last] = dialogue();

    assert.deepEqual(await listenTrack(ctx, pid, { lineIds: [last!.id] }), { track: { status: "building" } });
    await settledFor(2500);
    assert.equal((await listenTrack(ctx, pid, { lineIds: [last!.id] })).track.status, "ready");

    // A clip whose file has gone fails the build. Asking again inside the retry window answers
    // "failed" from the row and starts nothing.
    const [audio] = await resolveLineAudio(t.ctx, pid, [ben!.id], { priority: TTS_PRIORITY.render });
    assert.ok(audio?.audioKey);
    await t.ctx.storage.deleteKeys([audio.audioKey]);
    assert.deepEqual(await listenTrack(ctx, pid, { lineIds: [ben!.id] }), { track: { status: "building" } });
    await t.ctx.jobs.idle();
    const failedAt = async () =>
      (
        await t.ctx.sql<{ status: string; updatedAt: Date }[]>`select status, updated_at from listen_tracks where production_id = ${pid} and status = 'failed'`
      )[0];
    const failed = await failedAt();
    assert.ok(failed, "the build failed");
    for (let i = 0; i < 3; i++) assert.deepEqual(await listenTrack(ctx, pid, { lineIds: [ben!.id] }), { track: { status: "failed" } });
    await settledFor(500);
    assert.equal((await failedAt())!.updatedAt.getTime(), failed.updatedAt.getTime(), "not built again");
    assert.ok(RETRY_FAILED_MS >= 5 * 60_000);
  });
});
