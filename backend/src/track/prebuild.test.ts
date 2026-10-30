import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { Ctx } from "../context.ts";
import { resolveLineAudio } from "../linestream.ts";
import { silentLog } from "../log.ts";
import { makeTone } from "../render/ffmpeg.ts";
import { NORMALIZE_CONCURRENCY } from "../render/takeaudio.ts";
import { bearer, createTestApp, dbSkip, invite, productionWithScript, signIn, type TestApp } from "../test/helpers.ts";
import { FakeSynthesizer } from "../test/tts.ts";
import { TTS_PRIORITY } from "../tts/service.ts";
import { plannedTracks, prebuildTracks, stopPrebuilding } from "./prebuild.ts";
import { claimTrack, MAX_TRACK_LINES, TRACK_STRIDE, trackIdentity, trackLines, trackStart } from "./track.ts";

const line = (i: number, characterId: string | null, voiceIds: string[] | null = null) => ({
  id: `line-${i}`,
  kind: characterId || voiceIds ? "dialogue" : "stage_direction",
  characterId,
  voiceIds,
});

test("the tracks built ahead are the stretches the player asks for, read through and for each cast member's parts", () => {
  // 814 lines: ANNA speaks in the first 100 only, BEN throughout, a shared line at 700.
  const lines = Array.from({ length: 814 }, (_, i) =>
    i === 700 ? line(i, null, ["anna", "ben"]) : i % 10 === 0 ? line(i, null) : line(i, i < 100 && i % 2 ? "anna" : "ben"),
  );
  const planned = plannedTracks(lines, [["anna"], ["ben"], ["ben"], [], ["anna", "ben"]]);
  const starts = [...new Set(planned.map((p) => p.start))];
  assert.deepEqual(starts, [0, 260, 520]);
  assert.deepEqual(
    planned.map((p) => [p.start, p.req.mode, p.req.lineIds.length, p.req.mine.size]),
    [
      [0, "read", 300, 0],
      [0, "pause", 300, 50], // anna
      [0, "pause", 300, 220], // ben
      [0, "pause", 300, 270], // anna and ben
      [260, "read", 300, 0],
      // anna has no lines here: her listen is the full read, as the player asks for it
      [260, "pause", 300, 270],
      [260, "pause", 300, 270],
      [520, "read", 294, 0],
      [520, "pause", 294, 1], // anna: the shared line is hers too
      [520, "pause", 294, 265],
      [520, "pause", 294, 265],
    ],
    "the same parts twice (two cast members on BEN) are built once",
  );
  assert.ok(planned[7]!.req.mine.size === 0 && planned[8]!.req.mine.has("line-700"));

  // Every line's stretch, as the player works it out, is one built ahead and covers that line.
  for (const count of [1, 299, 300, 301, 560, 814, 1806]) {
    const built = plannedTracks(
      Array.from({ length: count }, (_, i) => line(i, "ben")),
      [],
    ).map((p) => p.start);
    for (let i = 0; i < count; i++) {
      const start = trackStart(i, count);
      assert.ok(built.includes(start), `line ${i} of ${count}: no track from ${start}`);
      assert.ok(i >= start && i < start + MAX_TRACK_LINES, `line ${i} of ${count} is outside the track from ${start}`);
    }
    // And the player asks for the next one REFRESH_LINES (40) before the end of each.
    for (const start of built.slice(1)) assert.equal(trackStart(start, count), start);
  }
  assert.equal(TRACK_STRIDE, MAX_TRACK_LINES - 40);
});

interface Row {
  id: string;
  hash: string;
  status: string;
  prebuilt: boolean;
  servedAt: Date | null;
  storageKey: string | null;
  createdAt: Date;
}

describe("listen tracks built ahead", { skip: dbSkip }, () => {
  const QUIET = 300;
  let t: TestApp;
  let alice: string;
  let pid: string;
  let lines: { id: string; kind: string; characterId: string | null; text: string }[];
  let annaId: string;
  let anna: string; // her invite URL
  let wav: Buffer;
  const playable = () => lines.filter((l) => l.kind === "dialogue" || l.kind === "stage_direction");
  const annaLines = () => playable().filter((l) => l.characterId === annaId);
  const rows = () =>
    t.ctx.sql<Row[]>`select id, hash, status, prebuilt, served_at, storage_key, created_at from listen_tracks where production_id = ${pid} order by created_at`;
  // Past the quiet time, then until every pass and build is done.
  const settle = async () => {
    await delay(QUIET + 150);
    await t.ctx.jobs.idle();
  };
  // What the player asks for, once: the full read, or Anna's "Pause, then read".
  const ask = (as: "director" | "anna") =>
    t.app.inject({
      method: "POST",
      url: as === "director" ? `/api/productions/${pid}/listen-track` : "/api/invite/listen-track",
      headers: as === "director" ? bearer(alice) : invite(anna),
      payload:
        as === "director"
          ? { lineIds: playable().map((l) => l.id) }
          : { lineIds: playable().map((l) => l.id), mine: annaLines().map((l) => l.id), mode: "pause" },
    });
  const takeOn = (lineId: string) =>
    t.app.inject({
      method: "PUT",
      url: `/api/lines/${lineId}/take`,
      headers: { ...bearer(alice), "content-type": "audio/wav", "x-take-id": randomUUID(), "x-duration-ms": "700" },
      payload: wav,
    });

  before(async () => {
    t = await createTestApp({ synthesizer: new FakeSynthesizer(), env: { PREBUILD_TRACKS: "1", TRACK_PREBUILD_QUIET_MS: String(QUIET) } });
    const dir = await mkdtemp(path.join(tmpdir(), "offbooked-take-"));
    await makeTone(0.7, 440, path.join(dir, "take.wav"));
    wav = await readFile(path.join(dir, "take.wav"));
    await rm(dir, { recursive: true, force: true });
    alice = await signIn(t, "alice@example.test");
    const made = await productionWithScript(
      t,
      alice,
      "ACT 1\nSCENE 1\nANNA: Hello there, how are you today.\nBEN: Very well, thank you.\nANNA: I am glad to hear it.\nSCENE 2\nBEN: Goodbye.\nCARL: Farewell, both.",
      "Prebuilt show",
    );
    pid = made.id;
    lines = made.script.lines;
    annaId = made.script.characters.find((c: { name: string }) => c.name === "ANNA").id;
  });
  after(async () => {
    stopPrebuilding(t.ctx);
    await t.close();
  });

  test("once the script is read, the full read is built before anyone presses play, and the first ask gets it", async () => {
    await settle();
    const built = await rows();
    assert.deepEqual(
      built.map((r) => [r.status, r.prebuilt, r.servedAt]),
      [["ready", true, null]],
    );
    const res = await ask("director");
    assert.equal(res.statusCode, 200, res.body);
    const track = res.json().track;
    assert.equal(track.status, "ready", "no wait for a build");
    assert.equal(track.items.length, playable().length);
    assert.ok((await rows())[0]!.servedAt, "marked as given to a listener");
  });

  test("a cast member picking a part gets their 'Pause, then read' built ahead", async () => {
    const { joinUrl } = (await t.app.inject({ method: "GET", url: `/api/productions/${pid}/join-link`, headers: bearer(alice) })).json();
    const claim = await t.app.inject({
      method: "POST",
      url: `/api/join/${joinUrl.split("/join/")[1]}/claim`,
      payload: { firstName: "Ana", characterIds: [annaId] },
    });
    assert.equal(claim.statusCode, 200, claim.body);
    anna = claim.json().inviteUrl;
    await settle();
    assert.equal((await rows()).filter((r) => r.status === "ready" && r.prebuilt).length, 2);
    const res = await ask("anna");
    assert.equal(res.statusCode, 200, res.body);
    const track = res.json().track;
    assert.equal(track.status, "ready");
    assert.deepEqual(
      track.items.filter((i: { kind: string }) => i.kind === "speak").map((i: { lineId: string }) => i.lineId),
      annaLines().map((l) => l.id),
    );
  });

  test("a take rebuilds the tracks holding its line; the ones a listener was given are left to the prune", async () => {
    const before = await rows();
    const ben = playable().find((l) => l.text.startsWith("Very well"))!;
    const take = await takeOn(ben.id);
    assert.equal(take.statusCode, 200, take.body);
    await settle();
    const now = await rows();
    const fresh = now.filter((r) => !before.some((b) => b.id === r.id));
    assert.deepEqual(
      fresh.map((r) => [r.status, r.prebuilt]),
      [
        ["ready", true],
        ["ready", true],
      ],
    );
    for (const old of before) {
      const row = now.find((r) => r.id === old.id);
      assert.ok(row, "given to a listener: kept for a phone that may still be playing it");
      assert.equal(row.prebuilt, false, "out of date: the usual 12-hour prune takes it");
    }
    const track = (await ask("director")).json().track;
    assert.equal(track.status, "ready");
    assert.equal(track.items.find((i: { lineId: string }) => i.lineId === ben.id).source, "director", "the new take is in it");
  });

  test("an edit to the script rebuilds them, and the out-of-date ones nobody was given go at once, files and all", async () => {
    const before = (await rows()).filter((r) => r.prebuilt);
    const unserved = before.filter((r) => !r.servedAt);
    assert.equal(unserved.length, 1, "Anna's newest track was never asked for");
    const carl = playable().find((l) => l.text.startsWith("Farewell"))!;
    const edit = await t.app.inject({ method: "PATCH", url: `/api/lines/${carl.id}`, headers: bearer(alice), payload: { text: "Farewell, the pair of you." } });
    assert.equal(edit.statusCode, 200, edit.body);
    await settle();
    const now = await rows();
    assert.equal(now.filter((r) => r.prebuilt && r.status === "ready").length, 2);
    assert.ok(!now.some((r) => r.id === unserved[0]!.id), "the row is gone");
    assert.equal(await t.ctx.storage.exists(unserved[0]!.storageKey!), false, "and its file");
    assert.equal((await ask("anna")).json().track.status, "ready");
  });

  test("opening the listen-through builds what is missing", async () => {
    await t.ctx.sql`delete from listen_tracks where production_id = ${pid}`;
    const open = await t.app.inject({ method: "GET", url: "/api/invite/runthrough", headers: invite(anna) });
    assert.equal(open.statusCode, 200);
    await settle();
    assert.equal((await rows()).filter((r) => r.prebuilt && r.status === "ready").length, 2);
    assert.equal((await ask("director")).json().track.status, "ready");
  });

  test("a listener's request is built before the ones waiting to be built ahead", async () => {
    const all = await trackLines(t.ctx, pid);
    const engine = await t.ctx.tts!.engine();
    const ahead = [0, 1, 2].map((i) => trackIdentity(all, { lineIds: [all[i]!.id, all[i + 1]!.id], mine: new Set(), mode: "read" }, engine));
    const claims = [];
    for (const a of ahead)
      claims.push(await claimTrack(t.ctx, pid, a.hash, a.lines, { lineIds: a.lines.map((l) => l.id), mine: new Set(), mode: "read" }, false));
    const asked = await t.app.inject({
      method: "POST",
      url: `/api/productions/${pid}/listen-track`,
      headers: bearer(alice),
      payload: { lineIds: [all[3]!.id, all[4]!.id] },
    });
    assert.deepEqual(asked.json(), { track: { status: "building" } });
    await t.ctx.jobs.idle();
    const done = await t.ctx.sql<{ hash: string; prebuilt: boolean }[]>`
      select hash, prebuilt from listen_tracks where production_id = ${pid} and status = 'ready' order by updated_at desc limit 4`;
    // Newest first: the last two built ahead came after the listener's, which waited only for the one already running.
    assert.deepEqual(
      done.map((d) => d.prebuilt),
      [true, true, false, true],
    );
    assert.deepEqual(
      done.filter((d) => d.prebuilt).map((d) => d.hash),
      [ahead[2]!.hash, ahead[1]!.hash, ahead[0]!.hash],
    );
  });

  // (All four for a listener waiting on them; a track's or the render's get three.)
  test("a stretch's takes are normalized four at a time, however many need it", async () => {
    const dialogue = playable().filter((l) => l.kind === "dialogue");
    for (const l of dialogue) assert.equal((await takeOn(l.id)).statusCode, 200);
    let active = 0;
    let most = 0;
    const storage = new Proxy(t.ctx.storage, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (prop === "get")
          return async (key: string) => {
            // The upload is read first thing in a normalization, and its FLAC written last.
            if (key.includes("/takes/")) most = Math.max(most, ++active);
            return value.call(target, key);
          };
        if (prop === "put")
          return async (key: string, ...rest: unknown[]) => {
            if (key.endsWith(".flac") && key.includes("/normalized/")) active--;
            return value.call(target, key, ...rest);
          };
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const audio = await resolveLineAudio(
      { ...t.ctx, storage },
      pid,
      dialogue.map((l) => l.id),
      { priority: TTS_PRIORITY.play, waitMs: 60_000 },
    );
    assert.ok(audio.every((a) => a.ready && a.audioKey && a.source === "director"));
    assert.equal(most, NORMALIZE_CONCURRENCY, `${dialogue.length} takes, at most ${NORMALIZE_CONCURRENCY} at once`);
  });

  test("a burst of takes is one pass once they stop, and an idle server sends no queries", { timeout: 60_000 }, async () => {
    let queries = 0;
    const sql = new Proxy(t.ctx.sql, {
      apply(target, self, args) {
        queries++;
        return Reflect.apply(target, self, args);
      },
    });
    let passes = 0;
    const log = { ...silentLog, info: (obj: object, msg?: string) => void (msg === "listen tracks prebuilt" && passes++) };
    const ctx: Ctx = { ...t.ctx, sql, log };

    // Kicks send nothing; each one inside the quiet time pushes the pass back.
    for (let i = 0; i < 4; i++) {
      prebuildTracks(ctx, pid, "take");
      await delay(QUIET / 2);
    }
    assert.equal(queries, 0, "a kick only sets a timer");
    assert.equal(passes, 0, "still inside the quiet time");
    await delay(QUIET + 150);
    await t.ctx.jobs.idle();
    assert.equal(passes, 1, "one pass for the burst");
    assert.ok(queries > 0);

    // Nothing to build (all current): the pass is a few queries, and then nothing at all.
    const settled = queries;
    await delay(3 * QUIET + 500);
    await t.ctx.jobs.idle();
    assert.equal(queries, settled, "the server kept querying while idle");
    assert.equal(passes, 1);
  });
});
