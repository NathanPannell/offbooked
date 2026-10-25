import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { shiftStretches, speechStretches, TRIM } from "./render/trim.ts";

/** What the trim keeps before the first sound. */
const L = TRIM.leadPadMs;
import type { Ctx } from "./context.ts";
import { backfillTiming, BACKFILL_RETRY_MS, MAX_BACKFILLS, servedSpeech, servedWordStarts, pieceCount } from "./taketiming.ts";
import { FakeAligner, type Heard } from "./test/align.ts";
import { bearer, createTestApp, dbSkip, invite, productionWithScript, signIn, type TestApp } from "./test/helpers.ts";

// Frame levels: `ms` of each level in turn, in 10 ms frames.
const levels = (...parts: [number, number][]) => parts.flatMap(([db, ms]) => Array<number>(ms / 10).fill(db));

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

// What the fake speech model hears in each take (see FakeAligner): the words of "Hello there,
// friend." in the tones of `audio` below, unless a test says otherwise.
const HELLO: Heard = [
  ["Hello", 500],
  ["there", 800],
  ["friend", 1500],
];

describe("take word timing", { skip: dbSkip }, () => {
  let t: TestApp;
  let alice: string;
  let pid: string;
  let lines: Line[];
  let riz: { inviteUrl: string };
  let hear: Heard | null = HELLO;
  const aligner = new FakeAligner(() => hear);
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
    t = await createTestApp({ aligner });
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

  test("a take is served with its stretches of speech and the words the server found, moved onto the trimmed clip", async () => {
    const line = lines[0]!;
    // The app's own word starts (here far off) are ignored: the take is still accepted.
    const res = await put(`/api/invite/lines/${line.id}/take`, invite(riz.inviteUrl), "1900,2000,2100");
    assert.equal(res.statusCode, 200, res.body);
    const body = await lineAudio(line.id);
    assert.equal(body.source, "actor");
    // The trim keeps TRIM.leadPadMs before the first word: the clip starts that much before 500 ms.
    const [row] = await t.ctx.sql<{ trimStartMs: number; speechMs: number[]; wordStartsMs: number[] | null; alignedWordStartsMs: number[] }[]>`
      select trim_start_ms, speech_ms, word_starts_ms, aligned_word_starts_ms from takes where line_id = ${line.id}`;
    assert.equal(row!.trimStartMs, 500 - TRIM.leadPadMs);
    assert.equal(row!.wordStartsMs, null, "the app's word starts aren't stored");
    assert.deepEqual(row!.alignedWordStartsMs, [500, 800, 1500], "the server's, in ms of the recording");
    assert.equal(row!.speechMs.length, 4, "stored once, with the take");
    assert.equal(body.speech?.length, 2, JSON.stringify(body.speech));
    near(body.speech![0]!.startMs, L, "first stretch starts");
    near(body.speech![0]!.endMs, L + 600, "first stretch ends");
    near(body.speech![1]!.startMs, L + 1000, "second stretch starts");
    near(body.speech![1]!.endMs, L + 1600, "second stretch ends");
    assert.ok(body.speech![1]!.endMs <= body.durationMs);
    assert.deepEqual(body.wordStartsMs, [L, L + 300, L + 1000]);
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

  test("the director's takes are timed the same way; a take where the line isn't found has none", async () => {
    const [, ben, anna2] = lines;
    hear = [
      ["And", 500],
      ["you", 1500],
    ];
    assert.equal((await put(`/api/lines/${ben!.id}/take`, bearer(alice))).statusCode, 200);
    assert.deepEqual((await lineAudio(ben!.id)).wordStartsMs, [L, L + 1000]);
    // Heard as other words entirely ("Goodbye now, Ben." isn't in it): cut by loudness, no word starts.
    hear = [
      ["Would", 500],
      ["the", 760],
      ["night", 1500],
    ];
    assert.equal((await put(`/api/lines/${anna2!.id}/take`, bearer(alice), "520,800,1520")).statusCode, 200);
    const body = await lineAudio(anna2!.id);
    assert.equal(body.wordStartsMs, undefined, "not even the app's");
    assert.equal(body.speech?.length, 2, "the speech is still known");
    const [row] = await t.ctx.sql<{ alignedWordStartsMs: number[] | null; trimStartMs: number }[]>`
      select aligned_word_starts_ms, trim_start_ms from takes where line_id = ${anna2!.id}`;
    assert.equal(row!.alignedWordStartsMs, null);
    assert.equal(row!.trimStartMs, 500 - L, "cut by loudness");
    hear = HELLO;
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
    assert.deepEqual(next.wordStartsMs, [L, L + 300, L + 1000]);
  });

  test("a take cut by an older version is cut again, and never served the word starts it had", async () => {
    const line = lines[0]!;
    // As a t7 take was left: the app's starts, re-timed on the voice, far off here.
    const asT7 = () => t.ctx.sql`
      update takes set normalized_key = replace(normalized_key, '.t8.', '.t7.'), aligned_word_starts_ms = '{1900,2000,2100}', word_starts_ms = '{1900,2000,2100}'
      where line_id = ${line.id}`;
    await asT7();
    hear = null; // and now no model: the take is cut again by loudness
    assert.equal((await lineAudio(line.id)).wordStartsMs, undefined);
    const [row] = await t.ctx.sql<{ normalizedKey: string; alignedWordStartsMs: number[] | null }[]>`
      select normalized_key, aligned_word_starts_ms from takes where line_id = ${line.id}`;
    assert.match(row!.normalizedKey, /\.t8\.flac$/);
    assert.equal(row!.alignedWordStartsMs, null);
    hear = HELLO;
    await asT7();
    assert.deepEqual((await lineAudio(line.id)).wordStartsMs, [L, L + 300, L + 1000], "found again by the next cut");
  });

  test("lines without a take have neither", async () => {
    const body = await lineAudio(lines[3]!.id);
    assert.equal(body.source, "none");
    assert.equal(body.speech, undefined);
    assert.equal(body.wordStartsMs, undefined);
  });

  test("older apps may still send the timing header, and the part headers", async () => {
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

describe("finding a take's words as soon as it is uploaded", { skip: dbSkip }, () => {
  let t: TestApp;
  let alice: string;
  let lineId: string;
  let hear: Heard | null = HELLO;
  const aligner = new FakeAligner(() => hear);
  before(async () => {
    t = await createTestApp({ env: { NORMALIZE_ON_UPLOAD: "1" }, aligner });
    alice = await signIn(t, "alice@example.test");
    const made = await productionWithScript(t, alice, "ANNA: Hello there, friend.\nBEN: And you.", "Soon");
    lineId = made.script.lines.find((l: Line) => l.kind === "dialogue").id;
  });
  after(() => t.close());

  interface Row {
    normalizedKey: string | null;
    trimStartMs: number;
    normalizedSamples: number;
    alignedWordStartsMs: number[] | null;
    wordStartsMs: number[] | null;
  }
  const upload = async (id: string, payload: Buffer, wordStarts?: string) => {
    const takeId = randomUUID();
    const res = await t.app.inject({
      method: "PUT",
      url: `/api/lines/${id}/take`,
      headers: {
        ...bearer(alice),
        "content-type": "audio/wav",
        "x-take-id": takeId,
        "x-duration-ms": String(Math.round(((payload.length - 44) / 32_000) * 1000)),
        ...(wordStarts ? { "x-word-starts": wordStarts } : {}),
      },
      payload,
    });
    assert.equal(res.statusCode, 200, res.body);
    await t.ctx.jobs.idle();
    const [row] = await t.ctx.sql<Row[]>`
      select normalized_key, trim_start_ms, normalized_samples, aligned_word_starts_ms, word_starts_ms from takes where id = ${takeId}`;
    return { ...row!, lengthMs: (row!.normalizedSamples * 1000) / 48_000 };
  };
  const andYou = async () => (await t.ctx.sql<{ id: string }[]>`select id from lines where text = 'And you.'`)[0]!.id;
  // A "hmm" (or a cue, or a false start) at 0.2–0.5 s, then the line: "And" at 3.1 s, "you." at
  // 4.1 s, then an "okay" at 5.5 s.
  const busy = () => wav([false, 200], [true, 300], [false, 2600], [true, 600], [false, 400], [true, 500], [false, 900], [true, 300], [false, 700]);

  test("normalizes the take in the background with the words found in it, whatever the app sent", async () => {
    const calls = aligner.calls;
    const row = await upload(lineId, wav([false, 500], [true, 600], [false, 400], [true, 600], [false, 500]), "520,800,1900");
    assert.ok(row.normalizedKey, "normalized without anyone playing it");
    assert.equal(aligner.calls, calls + 1);
    assert.deepEqual(row.alignedWordStartsMs, [500, 800, 1500]);
    assert.equal(row.wordStartsMs, null, "what the app sent isn't kept");
  });

  test("cuts by the line's words: speech before the line and after it isn't kept", async () => {
    hear = [
      ["hmm", 200],
      ["And", 3100],
      ["you", 4100],
      ["okay", 5500],
    ];
    const row = await upload(await andYou(), busy());
    assert.equal(row.trimStartMs, 3100 - L, "cut just before the first word, not before the hmm");
    assert.ok(Math.abs(row.lengthMs - (4600 + TRIM.tailPadMs - (3100 - L))) <= 40, `kept ${row.lengthMs} ms, not the okay`);
    assert.deepEqual(row.alignedWordStartsMs, [3100, 4100]);
  });

  test("a false start before the line is left out too", async () => {
    hear = [
      ["And", 200],
      ["And", 3100],
      ["you", 4100],
    ];
    const row = await upload(await andYou(), busy());
    assert.equal(row.trimStartMs, 3100 - L);
    assert.deepEqual(row.alignedWordStartsMs, [3100, 4100]);
  });

  test("when the line can't be found with confidence, the take is cut by loudness and has no word starts", async () => {
    hear = [
      ["Would", 200],
      ["the", 3100],
      ["night", 4100],
      ["were", 5500],
    ];
    const row = await upload(await andYou(), busy(), "3100,4100");
    assert.equal(row.trimStartMs, 0, "from the first sound (its pad reaches the start of the take)");
    assert.ok(Math.abs(row.lengthMs - (5800 + TRIM.tailPadMs)) <= 40, `kept ${row.lengthMs} ms`);
    assert.equal(row.alignedWordStartsMs, null);
    hear = null; // no model at all: the same
    const none = await upload(await andYou(), busy(), "3100,4100");
    assert.equal(none.trimStartMs, 0);
    assert.equal(none.alignedWordStartsMs, null);
    hear = HELLO;
  });

  test("a failing aligner never stops a take being normalized", async () => {
    const saved = t.ctx.aligner;
    t.ctx.aligner = { emissions: () => Promise.reject(new Error("model crashed")), close: async () => {} };
    try {
      const row = await upload(await andYou(), busy());
      assert.ok(row.normalizedKey);
      assert.equal(row.trimStartMs, 0);
      assert.equal(row.alignedWordStartsMs, null);
    } finally {
      t.ctx.aligner = saved;
    }
  });
});
