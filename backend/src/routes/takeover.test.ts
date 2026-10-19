import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { makeTone } from "../render/ffmpeg.ts";
import { SEED_SCENE } from "../seed-scene.ts";
import { bearer, createTestApp, dbSkip, productionWithScript, signIn, type TestApp } from "../test/helpers.ts";

interface ActorItem {
  line: { id: string; characterId: string };
  take: { id: string } | null;
  current: { source: "actor" | "standin"; by: string | null; audioUrl: string } | null;
}

describe("unassigning a part and picking up more", { skip: dbSkip }, () => {
  let t: TestApp;
  let director: string;
  let pid: string;
  let chars: Map<string, string>;
  let wav: Buffer;
  const get = (url: string, token = director) => t.app.inject({ method: "GET", url, headers: bearer(token) });
  const invite = (token: string) => ({ authorization: `Invite ${token}` });
  const lines = async (token: string) => (await t.app.inject({ method: "GET", url: "/api/invite/lines", headers: invite(token) })).json().lines as ActorItem[];
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

  test("a new actor takes over an unassigned part: earlier takes keep playing and can be recorded over", async () => {
    const riz = await claim("Riz", ["HAMLET"]);
    const [first, second] = await lines(riz);
    assert.equal((await upload(riz, first!.line.id)).statusCode, 200);

    // The director takes HAMLET away from Riz.
    const res = await t.app.inject({ method: "POST", url: `/api/productions/${pid}/characters/${chars.get("HAMLET")}/unassign`, headers: bearer(director) });
    assert.equal(res.statusCode, 204);
    assert.equal((await lines(riz)).length, 0, "Riz no longer has the part");
    const sheet = (await get(`/api/productions/${pid}/call-sheet`)).json().characters as { name: string; takenBy: string | null; linesRecorded: number }[];
    const hamlet = sheet.find((c) => c.name === "HAMLET")!;
    assert.equal(hamlet.takenBy, null);
    assert.equal(hamlet.linesRecorded, 1, "Riz's take still counts for the part");

    // Jo joined as Horatio, finishes, and picks up Hamlet too.
    const jo = await claim("Jo", ["HORATIO"]);
    const parts = (await t.app.inject({ method: "GET", url: "/api/invite/parts", headers: invite(jo) })).json().parts as {
      id: string;
      name: string;
      lineCount: number;
      linesNeeded: number;
    }[];
    const free = parts.find((p) => p.name === "HAMLET")!;
    assert.equal(free.linesNeeded, free.lineCount - 1);
    assert.ok(!parts.some((p) => p.name === "HORATIO"), "only free parts");
    const pick = await t.app.inject({ method: "POST", url: "/api/invite/parts", headers: invite(jo), payload: { characterIds: [free.id] } });
    assert.equal(pick.statusCode, 200, pick.body);
    assert.ok(pick.json().characters.some((c: { name: string }) => c.name === "HAMLET"));

    const mine = await lines(jo);
    const taken = mine.find((l) => l.line.id === first!.line.id)!;
    assert.equal(taken.take, null, "Riz's take isn't Jo's own");
    assert.equal(taken.current?.source, "actor");
    assert.equal(taken.current?.by, "Riz");
    assert.equal(mine.find((l) => l.line.id === second!.line.id)!.current, null, "still the computer voice");

    // Jo records over Riz's take.
    assert.equal((await upload(jo, first!.line.id)).statusCode, 200);
    const after = (await lines(jo)).find((l) => l.line.id === first!.line.id)!;
    assert.ok(after.take);
    assert.equal(after.current, null);

    // Someone else can't pick up a part that's taken.
    const lee = await claim("Lee", ["KING"]);
    const again = await t.app.inject({ method: "POST", url: "/api/invite/parts", headers: invite(lee), payload: { characterIds: [free.id] } });
    assert.equal(again.statusCode, 409);
  });

  test("a director's stand-in shows as what plays now until the actor records it", async () => {
    const queen = await claim("Ana", ["QUEEN"]);
    const [line] = await lines(queen);
    const standin = await t.app.inject({
      method: "PUT",
      url: `/api/lines/${line!.line.id}/take`,
      headers: { ...bearer(director), "content-type": "audio/wav", "x-take-id": randomUUID(), "x-duration-ms": "700" },
      payload: wav,
    });
    assert.equal(standin.statusCode, 200);
    const item = (await lines(queen)).find((l) => l.line.id === line!.line.id)!;
    assert.equal(item.current?.source, "standin");
    assert.equal(item.current?.by, null);
  });
});
