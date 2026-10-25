import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { after, before, describe, test } from "node:test";
import type { Log } from "../log.ts";
import { bearer, createTestApp, dbSkip, productionWithScript, signIn, type TestApp } from "../test/helpers.ts";
import { VOCAB_SIZE } from "./ctc.ts";
import { MODEL, ModelAligner, scaled, windowedEmissions, type LoadSession, type ModelSession } from "./model.ts";

const silentLog: Log = { info() {}, warn() {}, error() {} };

/** A model whose frame f of a window says, in token 1's logit, where the frame is in the whole take. */
function fakeSession(runs: { length: number }[] = []): ModelSession & { released: number } {
  let offset = 0;
  return {
    released: 0,
    async run(x) {
      runs.push({ length: x.length });
      const frames = Math.floor((x.length - 400) / MODEL.hop) + 1;
      const data = new Float32Array(frames * VOCAB_SIZE);
      for (let f = 0; f < frames; f++) data[f * VOCAB_SIZE + 1] = offset + f;
      offset += (MODEL.windowS - MODEL.overlapS) * (MODEL.rate / MODEL.hop);
      return { data, frames, vocab: VOCAB_SIZE };
    },
    async release() {
      this.released++;
    },
  };
}

test("scales a window to zero mean and unit variance", () => {
  const x = scaled(Int16Array.from([100, 300, 100, 300]), 0, 4);
  assert.deepEqual(
    [...x].map((v) => Number(v.toFixed(3))),
    [-1, 1, -1, 1],
  );
});

test("runs a long take in overlapping windows and stitches every frame once, in order", async () => {
  const runs: { length: number }[] = [];
  const seconds = 47;
  const em = (await windowedEmissions(fakeSession(runs), new Int16Array(seconds * MODEL.rate)))!;
  assert.equal(runs.length, Math.ceil((seconds - MODEL.overlapS) / (MODEL.windowS - MODEL.overlapS)));
  assert.ok(
    runs.every((r) => r.length <= MODEL.windowS * MODEL.rate),
    "no window longer than MODEL.windowS",
  );
  assert.ok(em.frames >= seconds * 50 - 2 && em.frames <= seconds * 50);
  // Token 1 holds each frame's place in the take (from the fake), so a stitched frame shows where it came from.
  for (let f = 0; f < em.frames; f++) assert.equal(Math.round(em.logp[f * VOCAB_SIZE + 1]! - em.logp[f * VOCAB_SIZE]!), f, `frame ${f}`);
  // Log-probabilities: each frame sums to one.
  const sum = em.logp.subarray(0, VOCAB_SIZE).reduce((a, v) => a + Math.exp(v), 0);
  assert.ok(Math.abs(sum - 1) < 1e-4);
  assert.equal(await windowedEmissions(fakeSession(), new Int16Array(300)), null, "too short to hear anything");
});

test("a model with another alphabet is refused", async () => {
  const session: ModelSession = { run: async () => ({ data: new Float32Array(10 * 29), frames: 10, vocab: 29 }), release: async () => {} };
  await assert.rejects(windowedEmissions(session, new Int16Array(MODEL.rate)), /29 tokens/);
});

describe("the model aligner", () => {
  test("without the model file it says so once and aligns nothing", async () => {
    const warnings: unknown[] = [];
    const log = { ...silentLog, warn: (...a: unknown[]) => warnings.push(a) } as never;
    let loads = 0;
    const aligner = new ModelAligner({ modelPath: "/nonexistent/model.onnx", threads: 1, log, load: async () => (loads++, fakeSession()) });
    assert.equal(await aligner.emissions(new Int16Array(MODEL.rate)), null);
    assert.equal(await aligner.emissions(new Int16Array(MODEL.rate)), null);
    assert.equal(warnings.length, 1);
    assert.equal(loads, 0);
  });

  test("loads the model on first use, keeps it while busy, lets it go once idle", async () => {
    const session = fakeSession();
    let loads = 0;
    const load: LoadSession = async () => (loads++, session);
    const aligner = new ModelAligner({ modelPath: import.meta.filename, threads: 1, log: silentLog, load, idleMs: 150 });
    const pcm = new Int16Array(MODEL.rate);
    await Promise.all([aligner.emissions(pcm), aligner.emissions(pcm), aligner.emissions(pcm)]);
    assert.equal(loads, 1);
    await delay(300);
    assert.equal(session.released, 1, "released after idleMs");
    await aligner.emissions(pcm);
    assert.equal(loads, 2, "loaded again when needed");
    await aligner.close();
    assert.equal(session.released, 2);
  });

  test("a model that fails to load or run is tried again next time", async () => {
    let fail = true;
    const aligner = new ModelAligner({
      modelPath: import.meta.filename,
      threads: 1,
      log: silentLog,
      load: async () => {
        if (fail) throw new Error("bad model");
        return fakeSession();
      },
    });
    await assert.rejects(aligner.emissions(new Int16Array(MODEL.rate)), /bad model/);
    fail = false;
    assert.ok(await aligner.emissions(new Int16Array(MODEL.rate)));
    await aligner.close();
  });

  test("one take at a time, a line someone is waiting for first", async () => {
    const order: number[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const session: ModelSession = {
      async run(x) {
        order.push(x.length);
        if (order.length === 1) await gate;
        return { data: new Float32Array(10 * VOCAB_SIZE), frames: 10, vocab: VOCAB_SIZE };
      },
      release: async () => {},
    };
    const aligner = new ModelAligner({ modelPath: import.meta.filename, threads: 1, log: silentLog, load: async () => session });
    const first = aligner.emissions(new Int16Array(1000), 3);
    await delay(20);
    const background = aligner.emissions(new Int16Array(2000), 3);
    const play = aligner.emissions(new Int16Array(3000), 0);
    await delay(20);
    assert.deepEqual(order, [1000], "only one at once");
    release();
    await Promise.all([first, background, play]);
    assert.deepEqual(order, [1000, 3000, 2000]);
    await aligner.close();
  });
});

// A 16 kHz mono WAV of tones and silence (`[tone?, ms]`).
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

describe("aligning uploaded takes", { skip: dbSkip }, () => {
  let t: TestApp;
  const session = fakeSession();
  before(async () => {
    t = await createTestApp({ env: { NORMALIZE_ON_UPLOAD: "1" } });
    t.ctx.aligner = new ModelAligner({ modelPath: import.meta.filename, threads: 1, log: silentLog, load: async () => session, idleMs: 300 });
  });
  after(async () => {
    await t.ctx.aligner?.close();
    await t.close();
  });

  test("sends no queries once the take is done, while the model waits to be let go and after", { timeout: 60_000 }, async () => {
    const alice = await signIn(t, "alice@example.test");
    const made = await productionWithScript(t, alice, "ANNA: Hello there, friend.\nBEN: And you.", "Idle");
    const lineId = made.script.lines.find((l: { kind: string }) => l.kind === "dialogue").id;
    // Counts every query from here on, so an idle queue and aligner can be shown to send none.
    let queries = 0;
    const real = t.ctx.sql;
    t.ctx.sql = new Proxy(real, {
      apply(target, self, args) {
        queries++;
        return Reflect.apply(target, self, args);
      },
    });
    try {
      const res = await t.app.inject({
        method: "PUT",
        url: `/api/lines/${lineId}/take`,
        headers: { ...bearer(alice), "content-type": "audio/wav", "x-take-id": randomUUID(), "x-duration-ms": "1600" },
        payload: wav([false, 500], [true, 600], [false, 500]),
      });
      assert.equal(res.statusCode, 200, res.body);
      await t.ctx.jobs.idle();
      const settled = queries;
      assert.ok(settled > 0);
      await delay(1000);
      assert.equal(session.released, 1, "the model was let go");
      assert.equal(queries, settled, "the queue or the aligner queried while idle");
    } finally {
      t.ctx.sql = real;
    }
  });
});
