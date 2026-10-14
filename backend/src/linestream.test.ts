import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { flacSamples, makeTone, normalizeClip, probeSamples } from "./render/ffmpeg.ts";
import { processDueRenders } from "./render/queue.ts";
import { SEED_SCENE } from "./seed-scene.ts";
import { bearer, createTestApp, dbSkip, invite, productionWithScript, signIn, type TestApp } from "./test/helpers.ts";
import { FakeSynthesizer } from "./test/tts.ts";
import { PriorityPool, TTS_PRIORITY } from "./tts/service.ts";
import { speakable, type Voice } from "./tts/voices.ts";

interface Line {
  id: string;
  kind: string;
  characterId: string | null;
  text: string;
}

// A fake synthesizer that holds every utterance until the test lets it go.
class GatedSynthesizer extends FakeSynthesizer {
  private gates: { text: string; go: () => void }[] = [];
  open = false;
  override async synthesize(text: string, voice: Voice, outWav: string): Promise<void> {
    if (!this.open) await new Promise<void>((go) => this.gates.push({ text, go }));
    return super.synthesize(text, voice, outWav);
  }
  get waiting(): number {
    return this.gates.length;
  }
  // Lets the oldest held utterance through and returns its text.
  releaseOne(): string {
    const g = this.gates.shift()!;
    g.go();
    return g.text;
  }
  releaseAll() {
    this.open = true;
    for (const g of this.gates.splice(0)) g.go();
  }
}

const tick = () => new Promise((r) => setTimeout(r, 20));
async function until(cond: () => boolean, what: string, ms = 10_000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await tick();
  }
}

test("the priority pool runs urgent work first and keeps a slot free of background work", async () => {
  const pool = new PriorityPool(2);
  const order: string[] = [];
  const gates = new Map<string, () => void>();
  const job = (name: string, priority: number) => {
    const t = pool.ticket(priority);
    const p = pool.use(t, async () => {
      order.push(name);
      await new Promise<void>((r) => gates.set(name, r));
    });
    return { t, p };
  };
  const r1 = job("render1", TTS_PRIORITY.render);
  const r2 = job("render2", TTS_PRIORITY.render);
  const r3 = job("render3", TTS_PRIORITY.render);
  await tick();
  assert.deepEqual(order, ["render1"], "background work leaves one slot free");
  const play = job("play", TTS_PRIORITY.play);
  await tick();
  assert.deepEqual(order, ["render1", "play"], "a listener's line starts at once in the free slot");
  const pre1 = job("prefetch1", TTS_PRIORITY.prefetch);
  const pre2 = job("prefetch2", TTS_PRIORITY.prefetch);
  pool.raise(r3.t, TTS_PRIORITY.play);
  gates.get("play")!();
  await play.p;
  await tick();
  assert.deepEqual(order, ["render1", "play", "render3"], "a raised ticket jumps the queue");
  gates.get("render3")!();
  await r3.p;
  await tick();
  gates.get("render1")!();
  await r1.p;
  await tick();
  assert.deepEqual(order.slice(3), ["prefetch1", "prefetch2"], "prefetches before the rest of the render, first come first served");
  gates.get("prefetch1")!();
  gates.get("prefetch2")!();
  await Promise.all([pre1.p, pre2.p]);
  await tick();
  gates.get("render2")!();
  await r2.p;
  assert.deepEqual(order, ["render1", "play", "render3", "prefetch1", "prefetch2", "render2"]);
  assert.equal(pool.queued, 0);
});

test("one ffmpeg run writes the normalized FLAC and the playback .m4a, and the FLAC header gives its length", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "offbooked-clip-"));
  try {
    const raw = path.join(dir, "raw.wav");
    await makeTone(1.2, 330, raw);
    const flac = path.join(dir, "n.flac");
    const m4a = path.join(dir, "n.m4a");
    const samples = await normalizeClip(raw, flac, m4a);
    assert.equal(await flacSamples(flac), await probeSamples(flac));
    assert.ok(Math.abs(samples - 1.2 * 48_000) < 4800, String(samples));
    assert.ok((await readFile(m4a)).length > 1000);
    assert.equal(await flacSamples(raw), null, "not a FLAC");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("line-by-line playback", { skip: dbSkip }, () => {
  let t: TestApp;
  let synth: GatedSynthesizer;
  let alice: string;
  let bob: string;
  let pid: string;
  let lines: Line[];
  let hamlet: { inviteUrl: string };
  let hamletId: string;
  let wav: Buffer;
  const dialogue = () => lines.filter((l) => l.kind === "dialogue");
  const get = (url: string, headers: Record<string, string>) => t.app.inject({ method: "GET", url, headers });
  const audio = (lineId: string, token = alice, prefetch = false) =>
    get(`/api/productions/${pid}/lines/${lineId}/audio${prefetch ? "?prefetch=1" : ""}`, bearer(token));
  const warm = (lineIds: string[], token = alice) =>
    t.app.inject({ method: "POST", url: `/api/productions/${pid}/lines/audio/warm`, headers: bearer(token), payload: { lineIds } });

  before(async () => {
    synth = new GatedSynthesizer();
    synth.open = true;
    // One synthesis at a time makes the queue order observable.
    t = await createTestApp({ synthesizer: synth, env: { TTS_CONCURRENCY: "1" } });
    const dir = await mkdtemp(path.join(tmpdir(), "offbooked-take-"));
    await makeTone(0.7, 440, path.join(dir, "take.wav"));
    wav = await readFile(path.join(dir, "take.wav"));
    await rm(dir, { recursive: true, force: true });
    alice = await signIn(t, "alice@example.test");
    bob = await signIn(t, "bob@example.test");
    const made = await productionWithScript(t, alice, SEED_SCENE, "Hamlet");
    pid = made.id;
    lines = made.script.lines;
    const chars = new Map(made.script.characters.map((c: { name: string; id: string }) => [c.name, c.id]));
    hamletId = chars.get("HAMLET") as string;
    hamlet = (await t.app.inject({ method: "POST", url: `/api/productions/${pid}/cast`, headers: bearer(alice), payload: { name: "Riz", characterIds: [chars.get("HAMLET")] } })).json().member;
  });
  after(() => t.close());

  test("auth and scoping: the director's own productions, and the actor's production", async () => {
    const line = dialogue()[0]!;
    assert.equal((await get(`/api/productions/${pid}/lines/${line.id}/audio`, {})).statusCode, 401);
    assert.equal((await audio(line.id, bob)).statusCode, 404, "another director's production");
    const direction = lines.find((l) => l.kind === "stage_direction")!;
    assert.equal((await audio(direction.id)).statusCode, 404, "only dialogue has audio");
    assert.equal((await audio(randomUUID())).statusCode, 404);
    assert.equal((await warm([line.id], bob)).statusCode, 404);
    assert.equal((await warm(["nope"])).statusCode, 400);
    assert.equal((await warm(Array.from({ length: 31 }, () => randomUUID()))).statusCode, 400);

    const mine = await get(`/api/invite/lines/${line.id}/audio`, invite(hamlet.inviteUrl));
    assert.equal(mine.statusCode, 200, mine.body);
    assert.equal(mine.json().source, "tts", "actors hear every line of their production, like the run-through");
    const other = await productionWithScript(t, bob, "ANNA: Hello there.\nBEN: Hi.", "Bob's show");
    const bobLine = other.script.lines.find((l: Line) => l.kind === "dialogue")!;
    assert.equal((await get(`/api/invite/lines/${bobLine.id}/audio`, invite(hamlet.inviteUrl))).statusCode, 404, "another production's line");
    assert.equal((await get(`/api/invite/lines/${line.id}/audio`, bearer(alice))).statusCode, 401, "the invite route needs an invite token");
    const warmed = await t.app.inject({ method: "POST", url: "/api/invite/lines/audio/warm", headers: invite(hamlet.inviteUrl), payload: { lineIds: [line.id, bobLine.id] } });
    assert.equal(warmed.statusCode, 200);
    assert.deepEqual(warmed.json().lines.map((l: { lineId: string }) => l.lineId), [line.id], "lines from elsewhere are left out");
    await t.ctx.jobs.idle();
  });

  test("an unrecorded line is synthesized on demand, once, and the clip plays", async () => {
    const line = dialogue()[3]!;
    const before = synth.calls.length;
    const [a, b] = await Promise.all([audio(line.id), audio(line.id)]);
    assert.equal(synth.calls.length, before + 1, "two listeners at once share one synthesis");
    for (const res of [a, b]) {
      assert.equal(res.statusCode, 200, res.body);
      const body = res.json();
      assert.equal(body.source, "tts");
      assert.equal(body.ready, true);
      assert.ok(body.durationMs > 200);
      const file = await t.app.inject({ method: "GET", url: new URL(body.audioUrl).pathname + new URL(body.audioUrl).search });
      assert.equal(file.statusCode, 200);
      assert.equal(file.headers["content-type"], "audio/mp4");
    }
    await audio(line.id);
    assert.equal(synth.calls.length, before + 1, "cached afterwards");
    const sources = (await get(`/api/productions/${pid}/runthrough`, bearer(alice))).json().sources;
    assert.equal(sources[line.id], "tts");
  });

  test("a listener's line jumps ahead of prefetching and the background render", async () => {
    synth.open = false;
    const [r1, r2, r3, p1, p2, now] = dialogue().slice(10, 16);
    // The render's queue, at the lowest priority (grouped by model, so order within it varies).
    const render = t.ctx.tts!.ensure(
      [r1!, r2!, r3!].map((l) => t.ctx.tts!.request("fake 1", { id: "test-voice", model: "m", speaker: null, gender: "m" } as unknown as Voice, l.text)!),
      { priority: TTS_PRIORITY.render },
    );
    await until(() => synth.waiting === 1, "the render to start its first clip");
    const warmed = await warm([p1!.id, p2!.id]);
    assert.equal(warmed.statusCode, 200);
    assert.deepEqual(warmed.json().lines.map((l: { ready: boolean; source: string }) => [l.ready, l.source]), [[false, "tts"], [false, "tts"]]);
    const listening = audio(now!.id);
    await until(() => t.ctx.tts!.queued === 5, "everything to queue");
    const order: string[] = [];
    while (order.length < 6) {
      await until(() => synth.waiting === 1, "the next clip");
      order.push(synth.releaseOne());
    }
    assert.deepEqual(order.slice(1, 4), [now!, p1!, p2!].map((l) => speakable(l.text)), "the listener's line, then the prefetches, then the render");
    const res = await listening;
    assert.equal(res.json().ready, true);
    await render;
    synth.releaseAll();
    await t.ctx.jobs.idle();
  });

  test("the render reuses clips made for playback, and playback reuses the render's", async () => {
    synth.releaseAll();
    await t.ctx.sql`update renders set run_after = now() where status = 'queued'`;
    await processDueRenders(t.ctx);
    const rt = (await get(`/api/productions/${pid}/runthrough`, bearer(alice))).json();
    assert.equal(rt.render.status, "ready", JSON.stringify(rt.render.status));
    const unique = new Set(dialogue().map((l) => `${l.characterId}|${l.text}`)).size;
    // The test above synthesized three render lines with a stand-in voice; everything else once.
    assert.equal(synth.calls.length, unique + 3);
    const before = synth.calls.length;
    const all = await warm(dialogue().slice(0, 30).map((l) => l.id));
    assert.ok(all.json().lines.every((l: { ready: boolean; audioUrl: string }) => l.ready && l.audioUrl), "every clip is ready after the render");
    assert.equal(synth.calls.length, before);
    // Timing from the render matches the clip lengths the player is given.
    const first = rt.render.timing[0];
    assert.ok(Math.abs(all.json().lines[0].durationMs - (first.endMs - first.startMs)) <= 1);
  });

  test("a take wins over TTS: actor and stand-in sources, normalized on demand", async () => {
    const own = dialogue().find((l) => l.characterId === hamletId)!;
    const partner = dialogue().find((l) => l.characterId !== hamletId)!;
    const put = (url: string, headers: Record<string, string>) =>
      t.app.inject({ method: "PUT", url, headers: { ...headers, "content-type": "audio/wav", "x-take-id": randomUUID(), "x-duration-ms": "700" }, payload: wav });
    assert.equal((await put(`/api/invite/lines/${own.id}/take`, invite(hamlet.inviteUrl))).statusCode, 200);
    assert.equal((await put(`/api/lines/${partner.id}/take`, bearer(alice))).statusCode, 200);
    const [mineRes, partnerRes] = await Promise.all([audio(own.id), audio(partner.id)]);
    const mine = mineRes.json();
    assert.equal(mine.source, "actor");
    assert.equal(mine.ready, true);
    assert.ok(Math.abs(mine.durationMs - 700) < 100, String(mine.durationMs));
    assert.match(mine.audioUrl, /normalized\/.*\.m4a/);
    assert.equal(partnerRes.json().source, "standin");
    const [row] = await t.ctx.sql<{ normalizedKey: string; streamKey: string }[]>`
      select normalized_key, stream_key from takes where line_id = ${own.id} order by created_at desc limit 1`;
    assert.ok(row!.normalizedKey && row!.streamKey, "the render's normalized FLAC is cached with the .m4a");
    const sources = (await get(`/api/productions/${pid}/runthrough`, bearer(alice))).json().sources;
    assert.equal(sources[own.id], "actor");
    assert.equal(sources[partner.id], "standin");
  });
});

describe("line-by-line playback without TTS", { skip: dbSkip }, () => {
  test("lines without takes are silent placeholders", async () => {
    const t = await createTestApp();
    try {
      const alice = await signIn(t, "alice@example.test");
      const made = await productionWithScript(t, alice, "ANNA: Hello there, how are you.\nBEN: Hi.", "Quiet");
      const line = made.script.lines.find((l: Line) => l.kind === "dialogue")!;
      const res = await t.app.inject({ method: "GET", url: `/api/productions/${made.id}/lines/${line.id}/audio`, headers: bearer(alice) });
      assert.deepEqual(res.json(), { lineId: line.id, audioUrl: null, durationMs: 1900, source: "none", ready: true });
    } finally {
      await t.close();
    }
  });
});
