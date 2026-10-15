import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { makeTone } from "../render/ffmpeg.ts";
import { SEED_SCENE } from "../seed-scene.ts";
import { bearer, createTestApp, dbSkip, productionWithScript, signIn, type TestApp } from "../test/helpers.ts";

interface Sheet {
  id: string;
  name: string;
  lineCount: number;
  linesRecorded: number;
  takenBy: string | null;
  mine: boolean;
}

describe("call sheet and recording a part yourself", { skip: dbSkip }, () => {
  let t: TestApp;
  let alice: string;
  let bob: string;
  let pid: string;
  let chars: Map<string, string>;
  let lines: { id: string; kind: string; characterId: string | null }[];
  let wav: Buffer;
  const get = (url: string, token = alice) => t.app.inject({ method: "GET", url, headers: bearer(token) });
  const post = (url: string, payload: object = {}, token = alice) => t.app.inject({ method: "POST", url, headers: bearer(token), payload });
  const sheet = async () => (await get(`/api/productions/${pid}/call-sheet`)).json().characters as Sheet[];
  const row = async (name: string) => (await sheet()).find((c) => c.name === name)!;
  const asInvite = (token: string) => ({ authorization: `Invite ${token}` });
  const upload = (token: string, lineId: string) =>
    t.app.inject({
      method: "PUT",
      url: `/api/invite/lines/${lineId}/take`,
      headers: { ...asInvite(token), "content-type": "audio/wav", "x-take-id": randomUUID(), "x-duration-ms": "700" },
      payload: wav,
    });

  before(async () => {
    t = await createTestApp();
    const dir = await mkdtemp(path.join(tmpdir(), "offbooked-take-"));
    await makeTone(0.7, 440, path.join(dir, "take.wav"));
    wav = await readFile(path.join(dir, "take.wav"));
    await rm(dir, { recursive: true, force: true });
    alice = await signIn(t, "alice@example.test");
    await t.app.inject({ method: "PATCH", url: "/api/me", headers: bearer(alice), payload: { name: "Alice Mono" } });
    bob = await signIn(t, "bob@example.test");
    const made = await productionWithScript(t, alice, SEED_SCENE, "Hamlet");
    pid = made.id;
    lines = made.script.lines;
    chars = new Map(made.script.characters.map((c: { name: string; id: string }) => [c.name, c.id]));
  });
  after(() => t.close());

  test("the call sheet lists speaking characters with who took them and their progress", async () => {
    const empty = await sheet();
    assert.ok(empty.length > 0);
    assert.ok(empty.every((c) => c.lineCount > 0 && c.linesRecorded === 0 && c.takenBy === null && !c.mine));
    assert.deepEqual(empty.map((c) => c.lineCount), [...empty.map((c) => c.lineCount)].sort((a, b) => b - a), "biggest parts first");
    assert.equal((await get(`/api/productions/${pid}/call-sheet`, bob)).statusCode, 404, "only the owner sees it");

    const { joinUrl } = (await get(`/api/productions/${pid}/join-link`)).json();
    const claim = await t.app.inject({
      method: "POST",
      url: `/api/join/${joinUrl.split("/join/")[1]}/claim`,
      payload: { firstName: "Riz", characterIds: [chars.get("HAMLET")] },
    });
    const hamletLine = lines.find((l) => l.kind === "dialogue" && l.characterId === chars.get("HAMLET"))!;
    assert.equal((await upload(claim.json().inviteToken, hamletLine.id)).statusCode, 200);
    const hamlet = await row("HAMLET");
    assert.equal(hamlet.takenBy, "Riz");
    assert.equal(hamlet.linesRecorded, 1);
    assert.equal(hamlet.mine, false);
  });

  test("the director records a part through their own cast member, reused across parts", async () => {
    const horatio = chars.get("HORATIO")!;
    const res = await post(`/api/productions/${pid}/record-as`, { characterId: horatio });
    assert.equal(res.statusCode, 200);
    const { inviteToken, inviteUrl } = res.json();
    assert.ok(inviteUrl.endsWith(`/i/${inviteToken}`));

    const invite = (await t.app.inject({ method: "GET", url: "/api/invite", headers: asInvite(inviteToken) })).json();
    assert.deepEqual(invite.characters.map((c: { name: string }) => c.name), ["HORATIO"]);
    assert.equal(invite.actor.firstName, "Alice", "named already, so the welcome step is skipped");

    const again = (await post(`/api/productions/${pid}/record-as`, { characterId: horatio })).json();
    assert.equal(again.inviteToken, inviteToken, "picking the same part again reuses the link");

    const marcellus = chars.get("MARCELLUS")!;
    const second = (await post(`/api/productions/${pid}/record-as`, { characterId: marcellus })).json();
    assert.equal(second.inviteToken, inviteToken, "one cast member for the director per production");
    const both = (await t.app.inject({ method: "GET", url: "/api/invite", headers: asInvite(inviteToken) })).json();
    assert.deepEqual(both.characters.map((c: { name: string }) => c.name).sort(), ["HORATIO", "MARCELLUS"]);

    const h = await row("HORATIO");
    assert.equal(h.takenBy, "Alice");
    assert.equal(h.mine, true);

    // Recording every line of a part counts as progress but sends no "finished" email to the director.
    const mine = lines.filter((l) => l.kind === "dialogue" && l.characterId === marcellus);
    for (const l of mine) assert.equal((await upload(inviteToken, l.id)).statusCode, 200);
    await t.ctx.jobs.idle();
    assert.equal((await row("MARCELLUS")).linesRecorded, mine.length);
    assert.ok(!t.mailer.sent.some((m) => /finished all/.test(m.subject)));
  });

  test("a part someone else has taken, a foreign character, bad input and other directors are refused", async () => {
    const taken = await post(`/api/productions/${pid}/record-as`, { characterId: chars.get("HAMLET") });
    assert.equal(taken.statusCode, 409);
    assert.equal(taken.json().error.code, "character_taken");
    assert.equal((await post(`/api/productions/${pid}/record-as`, { characterId: randomUUID() })).statusCode, 404);
    assert.equal((await post(`/api/productions/${pid}/record-as`, { characterId: "nope" })).statusCode, 400);
    assert.equal((await post(`/api/productions/${pid}/record-as`, { characterId: chars.get("HORATIO") }, bob)).statusCode, 404);

    const { joinUrl } = (await get(`/api/productions/${pid}/join-link`)).json();
    const steal = await t.app.inject({
      method: "POST",
      url: `/api/join/${joinUrl.split("/join/")[1]}/claim`,
      payload: { firstName: "Jo", characterIds: [chars.get("HORATIO")] },
    });
    assert.equal(steal.statusCode, 409, "the cast link can't claim a part the director is recording");
  });
});
