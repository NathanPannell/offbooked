import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { makeTone } from "../render/ffmpeg.ts";
import { SEED_SCENE } from "../seed-scene.ts";
import { MAX_TAKE_BYTES } from "../takes.ts";
import { bearer, createTestApp, dbSkip, productionWithScript, signIn, type TestApp } from "../test/helpers.ts";

describe("long takes", { skip: dbSkip }, () => {
  let t: TestApp;
  let token: string;
  let lineId: string;
  let long: Buffer;

  before(async () => {
    t = await createTestApp();
    // 130 s of 48 kHz mono WAV: over the old two-minute cap and too big for one request.
    const dir = await mkdtemp(path.join(tmpdir(), "offbooked-long-"));
    await makeTone(130, 330, path.join(dir, "long.wav"));
    long = await readFile(path.join(dir, "long.wav"));
    await rm(dir, { recursive: true, force: true });
    const director = await signIn(t, "director@example.test");
    const made = await productionWithScript(t, director, SEED_SCENE, "Hamlet");
    const chars = new Map(made.script.characters.map((c: { name: string; id: string }) => [c.name, c.id]));
    const { joinUrl } = (await t.app.inject({ method: "GET", url: `/api/productions/${made.id}/join-link`, headers: bearer(director) })).json();
    const claim = await t.app.inject({
      method: "POST",
      url: `/api/join/${joinUrl.split("/join/")[1]}/claim`,
      payload: { firstName: "Riz", characterIds: [chars.get("HAMLET")] },
    });
    token = claim.json().inviteToken;
    const lines = (await t.app.inject({ method: "GET", url: "/api/invite/lines", headers: { authorization: `Invite ${token}` } })).json().lines;
    lineId = lines[0].line.id;
  });
  after(() => t.close());

  test("a take over two minutes, too big for one request, goes up in parts and joins back", async () => {
    assert.ok(long.length > MAX_TAKE_BYTES, "the test take needs more than one request");
    const takeId = randomUUID();
    const half = Math.ceil(long.length / 2);
    const send = (index: number) =>
      t.app.inject({
        method: "PUT",
        url: `/api/invite/lines/${lineId}/take`,
        headers: {
          authorization: `Invite ${token}`,
          "content-type": "audio/wav",
          "x-take-id": takeId,
          "x-duration-ms": "130000",
          "x-take-parts": "2",
          "x-take-part": String(index),
        },
        payload: long.subarray(index * half, (index + 1) * half),
      });

    // The second part first: the server waits for the rest.
    const first = await send(1);
    assert.equal(first.statusCode, 200, first.body);
    assert.deepEqual(first.json(), { partial: true, parts: 2, missing: [0] });

    const second = await send(0);
    assert.equal(second.statusCode, 200, second.body);
    const { take } = second.json();
    assert.equal(take.id, takeId);
    assert.ok(Math.abs(take.durationMs - 130_000) < 500, `joined take is ${take.durationMs} ms`);

    // Sending a part again after it's saved just returns the take.
    const again = await send(1);
    assert.equal(again.json().take.id, takeId);
  });

  test("part headers are checked", async () => {
    const res = await t.app.inject({
      method: "PUT",
      url: `/api/invite/lines/${lineId}/take`,
      headers: {
        authorization: `Invite ${token}`,
        "content-type": "audio/wav",
        "x-take-id": randomUUID(),
        "x-take-parts": "99",
        "x-take-part": "0",
      },
      payload: long.subarray(0, 1000),
    });
    assert.equal(res.statusCode, 400);
  });
});
