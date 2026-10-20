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
  topRecorder: { name: string; others: number } | null;
  mine: boolean;
}

describe("call sheet: open parts, top recorders and the director's takes", { skip: dbSkip }, () => {
  let t: TestApp;
  let alice: string;
  let bob: string;
  let pid: string;
  let joinToken: string;
  let chars: Map<string, string>;
  let lines: { id: string; kind: string; characterId: string | null }[];
  let wav: Buffer;
  const get = (url: string, token = alice) => t.app.inject({ method: "GET", url, headers: bearer(token) });
  const post = (url: string, payload: object = {}, token = alice) => t.app.inject({ method: "POST", url, headers: bearer(token), payload });
  const sheet = async () => (await get(`/api/productions/${pid}/call-sheet`)).json().characters as Sheet[];
  const row = async (name: string) => (await sheet()).find((c) => c.name === name)!;
  const asInvite = (token: string) => ({ authorization: `Invite ${token}` });
  const audio = { "content-type": "audio/wav", "x-duration-ms": "700" };
  const upload = (token: string, lineId: string) =>
    t.app.inject({
      method: "PUT",
      url: `/api/invite/lines/${lineId}/take`,
      headers: { ...asInvite(token), ...audio, "x-take-id": randomUUID() },
      payload: wav,
    });
  const directorTake = (lineId: string) =>
    t.app.inject({ method: "PUT", url: `/api/lines/${lineId}/take`, headers: { ...bearer(alice), ...audio, "x-take-id": randomUUID() }, payload: wav });
  const linesOf = (name: string) => lines.filter((l) => l.kind === "dialogue" && l.characterId === chars.get(name));
  const claim = async (firstName: string, names: string[]) => {
    const res = await t.app.inject({
      method: "POST",
      url: `/api/join/${joinToken}/claim`,
      payload: { firstName, characterIds: names.map((n) => chars.get(n)) },
    });
    assert.equal(res.statusCode, 200, res.body);
    return res.json().inviteToken as string;
  };
  const cards = async () => (await t.app.inject({ method: "GET", url: `/api/join/${joinToken}` })).json().characters as (Sheet & { linesNeeded: number })[];

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
    joinToken = (await get(`/api/productions/${pid}/join-link`)).json().joinUrl.split("/join/")[1];
  });
  after(() => t.close());

  test("before anyone records, no part has a recorder", async () => {
    const empty = await sheet();
    assert.ok(empty.length > 0);
    assert.ok(empty.every((c) => c.lineCount > 0 && c.linesRecorded === 0 && c.topRecorder === null && !c.mine));
    assert.ok(empty.every((c) => !("takenBy" in c) && !("sharedLines" in c)));
    assert.deepEqual(
      empty.map((c) => c.lineCount),
      [...empty.map((c) => c.lineCount)].sort((a, b) => b - a),
      "biggest parts first",
    );
    assert.equal((await get(`/api/productions/${pid}/call-sheet`, bob)).statusCode, 404, "only the owner sees it");
  });

  test("two people can pick the same part; the label is whoever recorded most, plus the others", async () => {
    const riz = await claim("Riz", ["HAMLET"]);
    const jo = await claim("Jo", ["HAMLET", "QUEEN"]);
    const hamlet = linesOf("HAMLET");
    assert.equal((await upload(riz, hamlet[0]!.id)).statusCode, 200);
    assert.deepEqual((await row("HAMLET")).topRecorder, { name: "Riz", others: 0 });
    assert.deepEqual((await cards()).find((c) => c.name === "HAMLET")!.topRecorder, { name: "Riz", others: 0 }, "the join page shows the same label");

    assert.equal((await upload(jo, hamlet[1]!.id)).statusCode, 200);
    assert.equal((await upload(jo, hamlet[2]!.id)).statusCode, 200);
    assert.deepEqual((await row("HAMLET")).topRecorder, { name: "Jo", others: 1 });

    // The director records a line too: one more recorder, and HAMLET is one of the director's roles.
    assert.equal((await directorTake(hamlet[3]!.id)).statusCode, 200);
    const h = await row("HAMLET");
    assert.deepEqual(h.topRecorder, { name: "Jo", others: 2 });
    assert.equal(h.linesRecorded, 4);
    assert.equal(h.mine, true);
    assert.equal((await row("QUEEN")).mine, false);

    // Recording over someone's line moves it to the new recorder: Riz's only line goes to Jo.
    assert.equal((await upload(jo, hamlet[0]!.id)).statusCode, 200);
    assert.deepEqual((await row("HAMLET")).topRecorder, { name: "Jo", others: 1 });
  });

  test("the director's takes count towards progress and the join page's cards", async () => {
    const marcellus = linesOf("MARCELLUS");
    const before = (await get(`/api/productions/${pid}`)).json().production.progress.linesRecorded;
    for (const l of marcellus) assert.equal((await directorTake(l.id)).statusCode, 200);
    const m = await row("MARCELLUS");
    assert.equal(m.linesRecorded, marcellus.length);
    assert.deepEqual(m.topRecorder, { name: "Alice", others: 0 }, "the director's first name, as the cast sees it");
    assert.equal(m.mine, true);
    assert.equal((await get(`/api/productions/${pid}`)).json().production.progress.linesRecorded, before + marcellus.length);
    const card = (await cards()).find((c) => c.name === "MARCELLUS")!;
    assert.deepEqual([card.linesRecorded, card.linesNeeded, card.topRecorder], [marcellus.length, 0, { name: "Alice", others: 0 }]);
  });

  test("the director's takes finish a cast member's lines: actor progress and the email", async () => {
    const sam = await claim("Sam", ["QUEEN"]);
    const [first, ...rest] = linesOf("QUEEN");
    assert.equal((await upload(sam, first!.id)).statusCode, 200);
    for (const l of rest) assert.equal((await directorTake(l.id)).statusCode, 200);
    await t.ctx.jobs.idle();
    const invite = (await t.app.inject({ method: "GET", url: "/api/invite", headers: asInvite(sam) })).json();
    assert.equal(invite.linesRecorded, invite.linesTotal);
    assert.ok(t.mailer.sent.some((m) => m.subject === `Sam finished all ${invite.linesTotal} lines`));
    const items = (await t.app.inject({ method: "GET", url: "/api/invite/lines", headers: asInvite(sam) })).json().lines;
    assert.deepEqual(items[1].current.recordedBy, { kind: "director", name: "Alice" });
    assert.equal(items[1].current.mine, false);
  });

  test("no actor-done email for someone who recorded none of their lines, or for a second pick of a finished part", async () => {
    const zed = await claim("Zed", ["POLONIUS"]);
    for (const l of linesOf("POLONIUS")) assert.equal((await directorTake(l.id)).statusCode, 200);
    await claim("Sam", ["QUEEN"]); // Sam again, on another phone
    assert.equal((await directorTake(linesOf("KING")[0]!.id)).statusCode, 200);
    await t.ctx.jobs.idle();
    const invite = (await t.app.inject({ method: "GET", url: "/api/invite", headers: asInvite(zed) })).json();
    assert.equal(invite.linesRecorded, invite.linesTotal, "Zed's part is fully recorded");
    assert.ok(!t.mailer.sent.some((m) => m.subject.startsWith("Zed finished")), "but Zed recorded none of it");
    assert.equal(t.mailer.sent.filter((m) => m.subject.startsWith("Sam finished")).length, 1, "and Sam's second phone sends no second email");
  });

  test("there is no unassigning a part and no recording through a cast member of the director's own", async () => {
    const unassign = await post(`/api/productions/${pid}/characters/${chars.get("HAMLET")}/unassign`);
    assert.equal(unassign.statusCode, 404);
    assert.equal((await post(`/api/productions/${pid}/record-as`, { characterId: chars.get("HORATIO") })).statusCode, 404);
    assert.equal((await row("HAMLET")).linesRecorded, 4, "nothing changed");
  });
});
