import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { shiftStretches, speechStretches, TRIM } from "./render/trim.ts";

/** What the trim keeps before the first sound. */
const L = TRIM.leadPadMs;
import type { Ctx } from "./context.ts";
import {
  backfillTiming,
  BACKFILL_RETRY_MS,
  MAX_BACKFILLS,
  MAX_WORD_STARTS,
  parseWordStarts,
  servedSpeech,
  servedWordStarts,
  pieceCount,
  wordAnchors,
} from "./taketiming.ts";
import { bearer, createTestApp, dbSkip, invite, productionWithScript, signIn, type TestApp } from "./test/helpers.ts";

// Frame levels: `ms` of each level in turn, in 10 ms frames.
const levels = (...parts: [number, number][]) => parts.flatMap(([db, ms]) => Array<number>(ms / 10).fill(db));

test("the line's first and last said words, for cutting by them", () => {
  assert.deepEqual(wordAnchors([500, 800, 1500], "Hello there, friend."), { firstMs: 500, lastMs: 1500 });
  assert.deepEqual(wordAnchors([500, 900, 900], "Go [Exit] away"), { firstMs: 500, lastMs: 900 }, "the narrator's pieces don't count");
  assert.equal(wordAnchors([500, 800], "Hello there, friend."), null, "they don't fit the line");
  // "Um, I… [2.4 s] I shall in all": the lone short first word was something else.
  assert.deepEqual(wordAnchors([400, 3200, 3530, 3760], "I shall in all"), { firstMs: 3200, lastMs: 3760 });
  // With a comma after it, a pause after the first word is the actor's.
  assert.deepEqual(wordAnchors([400, 3200, 3530], "Ay, madam, common."), { firstMs: 400, lastMs: 3530 });
});

test("counts the words a character says as the web player does", () => {
  // The same lines as web/src/player/words.test.ts (lineTokens) and web/src/stt/wordTiming.test.ts.
  assert.equal(pieceCount("Is this a dagger\nwhich I see?"), 7);
  assert.equal(pieceCount("Now go. [To the Servant.] Was it not"), 8, "a [direction]'s words count too");
  assert.equal(pieceCount("Away![Exit.]"), 2);
  assert.equal(pieceCount("Stay [aside\nand hear"), 4, "an unclosed bracket runs to the end of its printed line");
  assert.equal(pieceCount("Go {beat} now\n—"), 2, "notes and wordless lines aren't said");
  assert.equal(pieceCount("Stay — go"), 3, "a dash among words is a piece");
  assert.equal(pieceCount("I *will* go _now_ **"), 4, "markup alone isn't a word");
  assert.equal(pieceCount("Now go. [Exit.] Was it {beat} not"), 6);
  assert.equal(pieceCount("Go [—] now"), 2, "a direction with no words in it has none");
  assert.equal(pieceCount(""), 0);
});

test("reads X-Word-Starts only when it fits the line", () => {
  const text = "Hello there, friend.";
  assert.deepEqual(parseWordStarts("500,800,1500", text, 2600), [500, 800, 1500]);
  assert.deepEqual(parseWordStarts(" 500, 800 ,1500 ", text, 2600), [500, 800, 1500]);
  assert.deepEqual(parseWordStarts("500,500,1500", text, 2600), [500, 500, 1500], "two words may start together");
  assert.equal(parseWordStarts("500,800", text, 2600), null, "one start per spoken word");
  assert.equal(parseWordStarts("500,400,1500", text, 2600), null, "starts never go back");
  assert.equal(parseWordStarts("500,800,9000", text, 2600), null, "past the end of the recording");
  assert.equal(parseWordStarts("500,eight,1500", text, 2600), null);
  assert.equal(parseWordStarts("-5,800,1500", text, 2600), null);
  assert.equal(parseWordStarts("", text, 2600), null);
  assert.equal(parseWordStarts(undefined, text, 2600), null);
  assert.equal(parseWordStarts(["500,800,1500"], text, 2600), null, "a repeated header");
  const long = Array.from({ length: MAX_WORD_STARTS + 1 }, (_, i) => "w" + i).join(" ");
  assert.equal(parseWordStarts(Array.from({ length: MAX_WORD_STARTS + 1 }, (_, i) => String(i)).join(","), long, 10_000), null);
});

test("serves word starts in ms of the trimmed clip", () => {
  const text = "Hello there, friend.";
  assert.deepEqual(servedWordStarts([500, 800, 1500], 380, 1960, text), [120, 420, 1120]);
  assert.deepEqual(servedWordStarts([100, 800, 3000], 380, 1960, text), [0, 420, 1960], "kept inside the clip");
  assert.equal(servedWordStarts([500, 800, 1500], 380, 1960, "Hello there."), undefined, "the line was edited since");
  assert.equal(servedWordStarts([500, 800, 1500], null, 1960, text), undefined, "the cut isn't known yet");
  assert.equal(servedWordStarts(null, 380, 1960, text), undefined);
});

test("finds stretches of speech, split on pauses of 150 ms or more", () => {
  const s = speechStretches(levels([-70, 500], [-20, 300], [-70, 100], [-20, 300], [-70, 300], [-22, 400], [-70, 500]));
  assert.deepEqual(s, [
    { startMs: 500, endMs: 1200 },
    { startMs: 1500, endMs: 1900 },
  ]);
  assert.equal(TRIM.pauseMs, 150);
  assert.deepEqual(speechStretches(levels([-70, 500], [-20, 300], [-70, 150], [-20, 300], [-70, 500])).length, 2);
  assert.deepEqual(speechStretches(levels([-70, 300], [-5, 20], [-70, 500], [-20, 600], [-70, 400])), [{ startMs: 820, endMs: 1420 }], "a click isn't speech");
  assert.deepEqual(speechStretches(levels([-20, 1000])), [], "no floor to tell speech from");
  assert.deepEqual(
    shiftStretches(
      [
        { startMs: 500, endMs: 1200 },
        { startMs: 1500, endMs: 1900 },
      ],
      380,
      1300,
    ),
    [
      { startMs: 120, endMs: 820 },
      { startMs: 1120, endMs: 1300 },
    ],
  );
  assert.deepEqual(servedSpeech([120, 820, 1120, 1700], 1300), [
    { startMs: 120, endMs: 820 },
    { startMs: 1120, endMs: 1300 },
  ]);
  assert.equal(servedSpeech([], 1300), undefined);
  assert.equal(servedSpeech(null, 1300), undefined);
});

// A stand-in context for the backfill: storage that answers (or fails, or waits) as told, and a
// database that records the updates.
function fakeCtx(get: (key: string) => Promise<Buffer>) {
  const gets: string[] = [];
  const updates: unknown[][] = [];
  const sql = (_strings: TemplateStringsArray, ...values: unknown[]) => {
    updates.push(values);
    return Promise.resolve([]);
  };
  const ctx = {
    storage: {
      get: (key: string) => {
        gets.push(key);
        return get(key);
      },
    },
    sql,
  } as unknown as Ctx;
  return { ctx, gets, updates };
}

describe("backfilling a take's timing", () => {
  const take = (name: string) => ({ id: `${name}-${randomUUID()}`, storageKey: `productions/p/takes/${name}.wav` });
  const audio = () => wav([false, 300], [true, 500], [false, 300]);

  test("works it out once and stores it", async () => {
    const { ctx, gets, updates } = fakeCtx(async () => audio());
    await backfillTiming(ctx, take("ok"), 860);
    assert.equal(gets.length, 1);
    assert.equal(updates.length, 1);
    assert.deepEqual(updates[0]![0], [L, L + 500], "the speech, moved onto the trimmed clip");
    assert.equal(updates[0]![1], 300 - L, "the trim's cut");
  });

  test("tries a take again after a passing failure, but only once the cooldown is over", async () => {
    let fail = true;
    const { ctx, gets, updates } = fakeCtx(async () => {
      if (fail) throw new Error("storage timed out");
      return audio();
    });
    const t = take("flaky");
    await assert.rejects(backfillTiming(ctx, t, 860, 1_000));
    fail = false;
    await backfillTiming(ctx, t, 860, 1_000 + BACKFILL_RETRY_MS - 1);
    assert.equal(gets.length, 1, "not again inside the cooldown");
    await backfillTiming(ctx, t, 860, 1_000 + BACKFILL_RETRY_MS);
    assert.equal(gets.length, 2);
    assert.equal(updates.length, 1);
  });

  test("never tries an upload ffmpeg can't read again", async () => {
    const { ctx, gets } = fakeCtx(async () => Buffer.from("not audio at all"));
    const t = take("garbage");
    await assert.rejects(backfillTiming(ctx, t, 860, 0));
    await backfillTiming(ctx, t, 860, BACKFILL_RETRY_MS * 10);
    assert.equal(gets.length, 1);
  });

  test("runs at most a couple at once; the rest wait for a later request", async () => {
    const gates: (() => void)[] = [];
    let hold = true;
    const { ctx, gets } = fakeCtx(async () => {
      if (hold) await new Promise<void>((go) => gates.push(go));
      return audio();
    });
    const takes = Array.from({ length: MAX_BACKFILLS + 1 }, (_, i) => take(`busy${i}`));
    const runs = takes.map((t) => backfillTiming(ctx, t, 860));
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(gets.length, MAX_BACKFILLS, "the extra one is skipped for now");
    assert.equal(backfillTiming(ctx, takes[0]!, 860), runs[0], "a take already running is shared");
    hold = false;
    gates.forEach((go) => go());
    await Promise.all(runs);
    await backfillTiming(ctx, takes[MAX_BACKFILLS]!, 860);
    assert.equal(gets.length, MAX_BACKFILLS + 1, "and done by the next request");
  });
});

// A 16 kHz mono WAV: silence and tones (`[tone?, ms]`), so the voice is exactly where the tones are.
function wav(...parts: [boolean, number][]): Buffer {
  const rate = 16_000;
  const samples = parts.flatMap(([tone, ms]) =>
    Array.from({ length: (rate * ms) / 1000 }, (_, i) => (tone ? Math.round(9000 * Math.sin((2 * Math.PI * 220 * i) / rate)) : 0)),
  );
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((v, i) => data.writeInt16LE(v, i * 2));
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "latin1");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVEfmt ", 8, "latin1");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "latin1");
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

interface Line {
  id: string;
  kind: string;
  characterId: string | null;
}

describe("take word timing", { skip: dbSkip }, () => {
  let t: TestApp;
  let alice: string;
  let pid: string;
  let lines: Line[];
  let riz: { inviteUrl: string };
  // 0.5 s quiet, "Hello there," 0.6 s, a pause, "friend." 0.6 s, then quiet.
  const audio = wav([false, 500], [true, 600], [false, 400], [true, 600], [false, 500]);
  const lineAudio = async (lineId: string) => {
    const res = await t.app.inject({ method: "GET", url: `/api/productions/${pid}/lines/${lineId}/audio`, headers: bearer(alice) });
    assert.equal(res.statusCode, 200, res.body);
    return res.json() as { durationMs: number; source: string; speech?: { startMs: number; endMs: number }[]; wordStartsMs?: number[] };
  };
  const put = (url: string, headers: Record<string, string>, wordStarts?: string) =>
    t.app.inject({
      method: "PUT",
      url,
      headers: {
        ...headers,
        "content-type": "audio/wav",
        "x-take-id": randomUUID(),
        "x-duration-ms": "2600",
        ...(wordStarts ? { "x-word-starts": wordStarts } : {}),
      },
      payload: audio,
    });
  const near = (actual: number, expected: number, what: string) =>
    assert.ok(Math.abs(actual - expected) <= 30, `${what}: ${actual}, expected about ${expected}`);

  before(async () => {
    t = await createTestApp();
    alice = await signIn(t, "alice@example.test");
    const made = await productionWithScript(t, alice, "ANNA: Hello there, friend.\nBEN: And you.\nANNA: Goodbye now, Ben.\nBEN: Farewell.", "Timing");
    pid = made.id;
    lines = made.script.lines.filter((l: Line) => l.kind === "dialogue");
    const anna = made.script.characters.find((c: { name: string }) => c.name === "ANNA").id;
    riz = (
      await t.app.inject({ method: "POST", url: `/api/productions/${pid}/cast`, headers: bearer(alice), payload: { name: "Riz", characterIds: [anna] } })
    ).json().member;
  });
  after(() => t.close());

  test("a take is served with its stretches of speech and its word starts, moved onto the trimmed clip", async () => {
    const line = lines[0]!;
    const res = await put(`/api/invite/lines/${line.id}/take`, invite(riz.inviteUrl), "520,800,1520");
    assert.equal(res.statusCode, 200, res.body);
    const body = await lineAudio(line.id);
    assert.equal(body.source, "actor");
    // The trim keeps TRIM.leadPadMs before the first sound: the clip starts that much before 500 ms.
    const [row] = await t.ctx.sql<{ trimStartMs: number; speechMs: number[]; wordStartsMs: number[] }[]>`
      select trim_start_ms, speech_ms, word_starts_ms from takes where line_id = ${line.id}`;
    assert.equal(row!.trimStartMs, 500 - TRIM.leadPadMs);
    assert.deepEqual(row!.wordStartsMs, [520, 800, 1520], "kept as the app sent them, in ms of the recording");
    assert.equal(row!.speechMs.length, 4, "stored once, with the take");
    assert.equal(body.speech?.length, 2, JSON.stringify(body.speech));
    near(body.speech![0]!.startMs, L, "first stretch starts");
    near(body.speech![0]!.endMs, L + 600, "first stretch ends");
    near(body.speech![1]!.startMs, L + 1000, "second stretch starts");
    near(body.speech![1]!.endMs, L + 1600, "second stretch ends");
    assert.ok(body.speech![1]!.endMs <= body.durationMs);
    // Re-timed on the voice (realign.ts): "Hello" where the voice starts, "there," within the first
    // stretch by length, "friend." where the voice comes back after the pause.
    assert.deepEqual(body.wordStartsMs, [L, L + 270, L + 1000]);
    const [aligned] = await t.ctx.sql<{ alignedWordStartsMs: number[] }[]>`select aligned_word_starts_ms from takes where line_id = ${line.id}`;
    assert.deepEqual(aligned!.alignedWordStartsMs, [500, 770, 1500], "stored in ms of the recording, beside what the app sent");
    // Served from what was stored, the same again (but for the signed URL's expiry, in whole seconds).
    const again = await lineAudio(line.id);
    assert.deepEqual({ ...again, audioUrl: undefined }, { ...body, audioUrl: undefined });
  });

  test("once normalized, the recorder plays the take cut to its voice, not the upload", async () => {
    const line = lines[0]!;
    const res = await t.app.inject({ method: "GET", url: "/api/invite/lines", headers: invite(riz.inviteUrl) });
    assert.equal(res.statusCode, 200, res.body);
    const take = (res.json() as { lines: { line: { id: string }; take: { audioUrl: string; durationMs: number } | null }[] }).lines.find(
      (l) => l.line.id === line.id,
    )!.take!;
    assert.match(take.audioUrl, /normalized/);
    assert.equal(take.durationMs, 2600, "still the recording's length");
  });

  test("the director's takes carry word starts too; ones that don't fit the line are dropped", async () => {
    const [, ben, anna2] = lines;
    assert.equal((await put(`/api/lines/${ben!.id}/take`, bearer(alice), "520,1520")).statusCode, 200);
    assert.deepEqual((await lineAudio(ben!.id)).wordStartsMs, [L, L + 1000]);
    // "Goodbye now, Ben." has three spoken words, not two: the take is kept, the starts aren't.
    assert.equal((await put(`/api/lines/${anna2!.id}/take`, bearer(alice), "520,1520")).statusCode, 200);
    const body = await lineAudio(anna2!.id);
    assert.equal(body.wordStartsMs, undefined);
    assert.equal(body.speech?.length, 2, "the speech is still known");
    const [row] = await t.ctx.sql<{ wordStartsMs: number[] | null }[]>`select word_starts_ms from takes where line_id = ${anna2!.id}`;
    assert.equal(row!.wordStartsMs, null);
  });

  test("word starts stop being served once the line is edited", async () => {
    const line = lines[0]!;
    await t.ctx.sql`update lines set text = 'Hello there, my friend.' where id = ${line.id}`;
    const body = await lineAudio(line.id);
    assert.equal(body.wordStartsMs, undefined);
    assert.equal(body.speech?.length, 2);
    await t.ctx.sql`update lines set text = 'Hello there, friend.' where id = ${line.id}`;
  });

  test("a take normalized before takes kept their speech has it worked out once, then served", async () => {
    const line = lines[0]!;
    await t.ctx.sql`update takes set speech_ms = null, trim_start_ms = null where line_id = ${line.id}`;
    const first = await lineAudio(line.id);
    assert.equal(first.speech, undefined, "not in the way of this answer");
    assert.equal(first.wordStartsMs, undefined, "not before the cut is known again");
    await t.ctx.jobs.idle();
    const [row] = await t.ctx.sql<{ trimStartMs: number; speechMs: number[] }[]>`select trim_start_ms, speech_ms from takes where line_id = ${line.id}`;
    assert.equal(row!.trimStartMs, 500 - L);
    const next = await lineAudio(line.id);
    assert.equal(next.speech?.length, 2);
    near(next.speech![1]!.startMs, L + 1000, "second stretch starts");
    assert.deepEqual(next.wordStartsMs, [L, L + 270, L + 1000]);
  });

  test("lines without a take have neither", async () => {
    const body = await lineAudio(lines[3]!.id);
    assert.equal(body.source, "none");
    assert.equal(body.speech, undefined);
    assert.equal(body.wordStartsMs, undefined);
  });

  test("the browser may send the timing and part headers", async () => {
    const res = await t.app.inject({
      method: "OPTIONS",
      url: `/api/lines/${lines[0]!.id}/take`,
      headers: {
        origin: "https://app.test",
        "access-control-request-method": "PUT",
        "access-control-request-headers": "x-word-starts,x-take-parts,x-take-part",
      },
    });
    const allowed = String(res.headers["access-control-allow-headers"]).toLowerCase();
    for (const h of ["x-word-starts", "x-take-parts", "x-take-part"]) assert.ok(allowed.includes(h), allowed);
  });
});

describe("re-timing a take as soon as it is uploaded", { skip: dbSkip }, () => {
  let t: TestApp;
  let alice: string;
  let lineId: string;
  before(async () => {
    t = await createTestApp({ env: { NORMALIZE_ON_UPLOAD: "1" } });
    alice = await signIn(t, "alice@example.test");
    const made = await productionWithScript(t, alice, "ANNA: Hello there, friend.\nBEN: And you.", "Soon");
    lineId = made.script.lines.find((l: Line) => l.kind === "dialogue").id;
  });
  after(() => t.close());

  test("normalizes the take in the background and lays the app's word starts on its voice", async () => {
    // The app heard "friend." a pause late; the server puts it where the voice comes back.
    const res = await t.app.inject({
      method: "PUT",
      url: `/api/lines/${lineId}/take`,
      headers: { ...bearer(alice), "content-type": "audio/wav", "x-take-id": randomUUID(), "x-duration-ms": "2600", "x-word-starts": "520,800,1900" },
      payload: wav([false, 500], [true, 600], [false, 400], [true, 600], [false, 500]),
    });
    assert.equal(res.statusCode, 200, res.body);
    await t.ctx.jobs.idle();
    const [row] = await t.ctx.sql<{ normalizedKey: string | null; streamKey: string | null; alignedWordStartsMs: number[] | null; wordStartsMs: number[] }[]>`
      select normalized_key, stream_key, aligned_word_starts_ms, word_starts_ms from takes where line_id = ${lineId}`;
    assert.ok(row!.normalizedKey && row!.streamKey, "normalized without anyone playing it");
    assert.deepEqual(row!.alignedWordStartsMs, [500, 770, 1500]);
    assert.deepEqual(row!.wordStartsMs, [520, 800, 1900], "what the app sent is kept");
  });
});
