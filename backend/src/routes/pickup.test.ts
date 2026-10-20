import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { makeTone } from "../render/ffmpeg.ts";
import { SEED_SCENE } from "../seed-scene.ts";
import { bearer, createTestApp, dbSkip, productionWithScript, signIn, type TestApp } from "../test/helpers.ts";

interface Recorded {
  recordedBy: { kind: "actor" | "director"; name: string };
  mine: boolean;
}

interface ActorItem {
  line: { id: string; characterId: string };
  take: ({ id: string } & Recorded) | null;
  current: ({ source: "actor" | "director"; by: string; audioUrl: string } & Recorded) | null;
}

interface Part {
  id: string;
  name: string;
  lineCount: number;
  linesRecorded: number;
  linesNeeded: number;
  topRecorder: { name: string; others: number } | null;
}

describe("picking parts that others have, and picking up more", { skip: dbSkip }, () => {
  let t: TestApp;
  let director: string;
  let pid: string;
  let chars: Map<string, string>;
  let wav: Buffer;
  const get = (url: string, token = director) => t.app.inject({ method: "GET", url, headers: bearer(token) });
  const invite = (token: string) => ({ authorization: `Invite ${token}` });
  const lines = async (token: string) => (await t.app.inject({ method: "GET", url: "/api/invite/lines", headers: invite(token) })).json().lines as ActorItem[];
  const parts = async (token: string) => (await t.app.inject({ method: "GET", url: "/api/invite/parts", headers: invite(token) })).json().parts as Part[];
  const upload = (token: string, lineId: string) =>
    t.app.inject({
      method: "PUT",
      url: `/api/invite/lines/${lineId}/take`,
      headers: { ...invite(token), "content-type": "audio/wav", "x-take-id": randomUUID(), "x-duration-ms": "700" },
      payload: wav,
    });
  const claim = async (firstName: string, names: string[]) => {
    const { joinUrl } = (await get(`/api/productions/${pid}/join-link`)).json();
    const res = await t.app.inject({
      method: "POST",
      url: `/api/join/${joinUrl.split("/join/")[1]}/claim`,
      payload: { firstName, characterIds: names.map((n) => chars.get(n)) },
    });
    assert.equal(res.statusCode, 200, res.body);
    return res.json().inviteToken as string;
  };

  before(async () => {
    t = await createTestApp();
    const dir = await mkdtemp(path.join(tmpdir(), "offbooked-take-"));
    await makeTone(0.7, 440, path.join(dir, "take.wav"));
    wav = await readFile(path.join(dir, "take.wav"));
    await rm(dir, { recursive: true, force: true });
    director = await signIn(t, "director@example.test");
    const made = await productionWithScript(t, director, SEED_SCENE, "Hamlet");
    pid = made.id;
    chars = new Map(made.script.characters.map((c: { name: string; id: string }) => [c.name, c.id]));
  });
  after(() => t.close());

  test("a new phone picks the same part again: earlier takes count as recorded and can be recorded over", async () => {
    const riz = await claim("Riz", ["HAMLET"]);
    const [first, second] = await lines(riz);
    assert.equal((await upload(riz, first!.line.id)).statusCode, 200);
    const own = (await lines(riz)).find((l) => l.line.id === first!.line.id)!;
    assert.deepEqual([own.take?.recordedBy, own.take?.mine], [{ kind: "actor", name: "Riz" }, true]);

    // Riz again, on another phone: the part is still there to pick.
    const riz2 = await claim("Riz", ["HAMLET"]);
    const mine = await lines(riz2);
    const earlier = mine.find((l) => l.line.id === first!.line.id)!;
    assert.equal(earlier.take, null, "the first phone's take isn't this one's own");
    assert.equal(earlier.current?.source, "actor");
    assert.equal(earlier.current?.by, "Riz");
    assert.deepEqual([earlier.current?.recordedBy, earlier.current?.mine], [{ kind: "actor", name: "Riz" }, false]);
    assert.equal(mine.find((l) => l.line.id === second!.line.id)!.current, null, "still the computer voice");
    const invite2 = (await t.app.inject({ method: "GET", url: "/api/invite", headers: invite(riz2) })).json();
    assert.equal(invite2.linesRecorded, 1, "a take by anyone counts for the line");

    assert.equal((await upload(riz2, first!.line.id)).statusCode, 200);
    const after = (await lines(riz2)).find((l) => l.line.id === first!.line.id)!;
    assert.ok(after.take?.mine);
    assert.equal(after.current, null);
  });

  test("pick up more lines lists every part the actor hasn't picked, whoever else has", async () => {
    const jo = await claim("Jo", ["HORATIO"]);
    const list = await parts(jo);
    const hamlet = list.find((p) => p.name === "HAMLET")!;
    assert.ok(hamlet, "parts others have picked are listed");
    assert.equal(hamlet.linesNeeded, hamlet.lineCount - 1);
    assert.deepEqual(hamlet.topRecorder, { name: "Riz", others: 0 });
    assert.ok(!list.some((p) => p.name === "HORATIO"), "not the actor's own parts");
    assert.deepEqual(
      list.map((p) => p.linesNeeded),
      [...list.map((p) => p.linesNeeded)].sort((a, b) => b - a),
      "most needed first",
    );

    const pick = await t.app.inject({ method: "POST", url: "/api/invite/parts", headers: invite(jo), payload: { characterIds: [hamlet.id] } });
    assert.equal(pick.statusCode, 200, pick.body);
    assert.deepEqual(
      pick.json().characters.map((c: { name: string }) => c.name),
      ["HAMLET", "HORATIO"],
    );
    // Picking it again is harmless.
    const again = await t.app.inject({ method: "POST", url: "/api/invite/parts", headers: invite(jo), payload: { characterIds: [hamlet.id] } });
    assert.equal(again.statusCode, 200);
    assert.equal(again.json().characters.length, 2);

    const groupOrForeign = await t.app.inject({ method: "POST", url: "/api/invite/parts", headers: invite(jo), payload: { characterIds: [randomUUID()] } });
    assert.equal(groupOrForeign.statusCode, 400);
  });

  test("the director's take shows as what plays now, and counts as recorded", async () => {
    const ana = await claim("Ana", ["QUEEN"]);
    const [line] = await lines(ana);
    const take = await t.app.inject({
      method: "PUT",
      url: `/api/lines/${line!.line.id}/take`,
      headers: { ...bearer(director), "content-type": "audio/wav", "x-take-id": randomUUID(), "x-duration-ms": "700" },
      payload: wav,
    });
    assert.equal(take.statusCode, 200);
    assert.deepEqual([take.json().take.recordedBy, take.json().take.mine], [{ kind: "director", name: "Director" }, true]);
    const item = (await lines(ana)).find((l) => l.line.id === line!.line.id)!;
    assert.equal(item.current?.source, "director");
    assert.equal(item.current?.by, "Director");
    const invite = (await t.app.inject({ method: "GET", url: "/api/invite", headers: { authorization: `Invite ${ana}` } })).json();
    assert.equal(invite.linesRecorded, 1);
  });
});
