import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { SEED_SCENE } from "../seed-scene.ts";
import { bearer, createTestApp, dbSkip, productionWithScript, signIn, type TestApp } from "../test/helpers.ts";

describe("cast join link and script source", { skip: dbSkip }, () => {
  let t: TestApp;
  let alice: string;
  let bob: string;
  let pid: string;
  let characters: { id: string; name: string }[];
  const get = (url: string, token?: string) => t.app.inject({ method: "GET", url, headers: token ? bearer(token) : {} });
  const post = (url: string, payload: object = {}, token?: string) => t.app.inject({ method: "POST", url, headers: token ? bearer(token) : {}, payload });
  const tokenOf = (joinUrl: string) => joinUrl.split("/join/")[1]!;

  before(async () => {
    t = await createTestApp();
    alice = await signIn(t, "alice@example.test");
    bob = await signIn(t, "bob@example.test");
    let script;
    ({ id: pid, script } = await productionWithScript(t, alice, SEED_SCENE, "Hamlet"));
    characters = script.characters;
  });
  after(() => t.close());

  test("a cast member opens the link, picks characters and gets their recording link", async () => {
    const { joinUrl } = (await get(`/api/productions/${pid}/join-link`, alice)).json();
    assert.equal((await get(`/api/productions/${pid}/join-link`, bob)).statusCode, 404, "only the owner sees the link");
    const token = tokenOf(joinUrl);

    const open = (await get(`/api/join/${token}`)).json();
    assert.equal(open.production.title, "Hamlet");
    assert.ok(open.characters.every((c: { lineCount: number; takenBy: string | null }) => c.lineCount > 0 && c.takenBy === null));

    const hamlet = characters.find((c) => c.name === "HAMLET")!;
    const horatio = characters.find((c) => c.name === "HORATIO")!;
    const claim = await post(`/api/join/${token}/claim`, { firstName: "Riz", characterIds: [hamlet.id, horatio.id] });
    assert.equal(claim.statusCode, 200);
    const { inviteToken } = claim.json();
    const invite = await t.app.inject({ method: "GET", url: "/api/invite", headers: { authorization: `Invite ${inviteToken}` } });
    assert.equal(invite.statusCode, 200);
    assert.deepEqual(invite.json().characters.map((c: { name: string }) => c.name).sort(), ["HAMLET", "HORATIO"]);

    const after = (await get(`/api/join/${token}`)).json();
    assert.equal(after.characters.find((c: { id: string }) => c.id === hamlet.id).takenBy, "Riz");
    const again = await post(`/api/join/${token}/claim`, { firstName: "Jo", characterIds: [hamlet.id] });
    assert.equal(again.statusCode, 409, "a taken character can't be claimed again");
    assert.equal(again.json().error.code, "character_taken");
  });

  test("resetting the link revokes the old one; forged and invite tokens are refused", async () => {
    const old = tokenOf((await get(`/api/productions/${pid}/join-link`, alice)).json().joinUrl);
    const fresh = tokenOf((await post(`/api/productions/${pid}/join-link/reset`, {}, alice)).json().joinUrl);
    assert.notEqual(old, fresh);
    assert.equal((await get(`/api/join/${old}`)).statusCode, 404);
    assert.equal((await get(`/api/join/${fresh}`)).statusCode, 200);
    assert.equal((await get(`/api/join/${fresh.slice(0, -2)}xx`)).statusCode, 404);
    const cast = (await get(`/api/productions/${pid}/cast`, alice)).json().cast;
    const inviteToken = cast[0].inviteUrl.split("/i/")[1];
    assert.equal((await get(`/api/join/${inviteToken}`)).statusCode, 404, "an actor's invite token is not a join token");
  });

  test("the script source view returns the prepared text around a line, and the original file", async () => {
    const script = (await get(`/api/productions/${pid}/script`, alice)).json();
    const withSource = script.lines.find((l: { sourceLine: number | null }) => l.sourceLine);
    assert.ok(withSource, "parsed lines point at their source line");
    const source = (await get(`/api/productions/${pid}/script/source?line=${withSource.sourceLine}&context=3`, alice)).json();
    assert.equal(source.kind, "text");
    assert.equal(source.pageCount, null);
    assert.ok(source.lines.some((l: { n: number }) => l.n === withSource.sourceLine));
    assert.equal((await get(`/api/productions/${pid}/script/source?line=1`, bob)).statusCode, 404);
    const file = await get(`/api/productions/${pid}/script/file`, alice);
    assert.equal(file.statusCode, 200);
    assert.match(file.headers["content-type"] as string, /text\/plain/);
    assert.ok(file.body.includes("HAMLET"));
  });
});
